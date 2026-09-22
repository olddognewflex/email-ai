import { Injectable, Logger } from "@nestjs/common";
import { EmailClassification, NormalizedEmail } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import {
  EmailClassificationInput,
  EmailClassificationOutput,
  EmailClassificationOutputSchema,
  LlmRequest,
} from "@email-ai/shared";
import { buildClassificationPrompt } from "./classification.prompt";
import { AiProviderService } from "../ai-provider/ai-provider.service";
import { BreakerOpenError } from "../ai-provider/ai-provider.error";

@Injectable()
export class ClassificationService {
  private readonly logger = new Logger(ClassificationService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly aiProviderService: AiProviderService,
  ) {}

  async classifyEmail(normalizedEmailId: string): Promise<EmailClassification> {
    const normalized = await this.db.normalizedEmail.findUnique({
      where: { id: normalizedEmailId },
      include: { parsedEmail: true, classification: true },
    });

    if (!normalized) {
      throw new Error(`Normalized email ${normalizedEmailId} not found`);
    }

    if (normalized.classification) {
      this.logger.debug(
        `Email ${normalizedEmailId} already classified, returning existing`,
      );
      return normalized.classification;
    }

    const input = this.buildInput(normalized);
    const prompt = buildClassificationPrompt(input);

    let rawResponse: string | null = null;
    let classificationError: string | null = null;
    let output: EmailClassificationOutput;
    let providerUsed: string | null = null;

    // Reasoning models spend hidden thinking tokens from the same
    // budget; too low a cap truncates the visible JSON mid-string.
    const request: LlmRequest = {
      prompt,
      temperature: 0.3,
      maxTokens: Number(process.env.AI_MAX_TOKENS) || 4000,
    };

    providerUsed = await this.aiProviderService.getActiveProviderType();

    // A provider/breaker failure means we never got an answer. Let it
    // propagate and leave the email unclassified for a later run, rather
    // than poisoning it with a fallback classification that marks it done.
    const response = await this.aiProviderService.complete(request);
    rawResponse = response.content;

    try {
      output = this.parseAndValidateResponse(rawResponse);
    } catch (error) {
      // A real-but-unparseable response is a genuine fallback case.
      this.logger.warn(
        `Classification response invalid for ${normalizedEmailId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      classificationError =
        error instanceof Error ? error.message : "Unknown error";
      output = this.createFallbackOutput();
      providerUsed = "fallback";
    }

    return this.db.emailClassification.upsert({
      where: { normalizedEmailId },
      create: {
        normalizedEmailId,
        category: output.category,
        importance: output.importance,
        urgency: output.urgency,
        recommendedAction: output.recommendedAction,
        confidence: output.confidence,
        needsReview: output.needsReview,
        reason: output.reason,
        rawResponse,
        classificationError,
        providerUsed,
      },
      update: {
        category: output.category,
        importance: output.importance,
        urgency: output.urgency,
        recommendedAction: output.recommendedAction,
        confidence: output.confidence,
        needsReview: output.needsReview,
        reason: output.reason,
        rawResponse,
        classificationError,
        providerUsed,
      },
    });
  }

  async processUnclassified(since?: Date): Promise<{
    processed: number;
    errors: number;
    needsReview: number;
    skipped: number;
  }> {
    const unclassified = await this.db.normalizedEmail.findMany({
      where: {
        classification: null,
        ...(since && {
          parsedEmail: { rawEmail: { internalDate: { gte: since } } },
        }),
      },
      select: { id: true },
    });

    // Circuit breaker: if a prior run hit a quota/auth wall, skip the whole
    // batch cheaply instead of firing one doomed request per email.
    const breaker = this.aiProviderService.getBreakerStatus();
    if (breaker.open) {
      this.logger.warn(
        `AI breaker open until ${breaker.nextAllowedAttempt} ` +
          `(${breaker.reason ?? "unknown"}); skipping ${unclassified.length} email(s)`,
      );
      return {
        processed: 0,
        errors: 0,
        needsReview: 0,
        skipped: unclassified.length,
      };
    }

    let processed = 0;
    let errors = 0;
    let needsReviewCount = 0;
    let skipped = 0;

    for (const { id } of unclassified) {
      try {
        const classification = await this.classifyEmail(id);
        processed++;
        if (classification.needsReview) {
          needsReviewCount++;
        }
      } catch (error) {
        // The breaker tripped mid-batch (first quota/auth error opened it,
        // this is the next email short-circuiting). Stop rather than log a
        // failure per remaining email.
        if (error instanceof BreakerOpenError) {
          skipped = unclassified.length - processed - errors;
          this.logger.warn(
            `AI breaker opened mid-batch (until ${error.nextAllowedAttempt}); ` +
              `deferring ${skipped} email(s)`,
          );
          break;
        }
        this.logger.error(`Failed to classify normalized email ${id}`, error);
        errors++;
      }
    }

    this.logger.log(
      `Classified ${processed} emails (${needsReviewCount} need review, ` +
        `${errors} errors, ${skipped} deferred)`,
    );

    return { processed, errors, needsReview: needsReviewCount, skipped };
  }

  private buildInput(
    normalized: NormalizedEmail & {
      parsedEmail: {
        subject: string | null;
        fromAddress: string | null;
        fromName: string | null;
      };
    },
  ): EmailClassificationInput {
    return {
      subject: normalized.parsedEmail.subject,
      fromAddress: normalized.parsedEmail.fromAddress,
      fromName: normalized.parsedEmail.fromName,
      cleanedText: normalized.cleanedText,
      ruleCategory: normalized.ruleCategory,
      ruleConfidence: normalized.ruleConfidence,
      ruleReasons: normalized.ruleReasons,
      isNewsletter: normalized.isNewsletter,
      isBulk: normalized.isBulk,
      senderDomain: normalized.senderDomain,
    };
  }

  private parseAndValidateResponse(
    rawResponse: string,
  ): EmailClassificationOutput {
    let parsed: unknown;

    try {
      const cleaned = rawResponse
        .replace(/^```json\s*/, "")
        .replace(/```\s*$/, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`Invalid JSON response: ${rawResponse.slice(0, 200)}`);
    }

    const result = EmailClassificationOutputSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(
        `Schema validation failed: ${result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`,
      );
    }

    return result.data;
  }

  private createFallbackOutput(): EmailClassificationOutput {
    return {
      category: "unknown",
      importance: "low",
      urgency: "none",
      recommendedAction: "no_action",
      confidence: "low",
      needsReview: true,
      reason: "Classification failed - manual review required",
    };
  }

  async getStats(): Promise<{
    total: number;
    byProvider: Record<string, number>;
    aiClassified: number;
    fallbackClassified: number;
    needsReview: number;
    byCategory: Record<string, number>;
  }> {
    const allClassifications = await this.db.emailClassification.findMany({
      select: {
        providerUsed: true,
        category: true,
        needsReview: true,
      },
    });

    const stats = {
      total: allClassifications.length,
      byProvider: {} as Record<string, number>,
      aiClassified: 0,
      fallbackClassified: 0,
      needsReview: 0,
      byCategory: {} as Record<string, number>,
    };

    for (const c of allClassifications) {
      const provider = c.providerUsed ?? "unknown";
      stats.byProvider[provider] = (stats.byProvider[provider] ?? 0) + 1;

      if (c.providerUsed && c.providerUsed !== "fallback") {
        stats.aiClassified++;
      } else if (c.providerUsed === "fallback") {
        stats.fallbackClassified++;
      }

      if (c.needsReview) {
        stats.needsReview++;
      }

      stats.byCategory[c.category] = (stats.byCategory[c.category] ?? 0) + 1;
    }

    return stats;
  }
}
