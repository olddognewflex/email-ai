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
import {
  CLASSIFICATION_QUESTION_SET_VERSION,
  buildClassificationJudgeRequest,
} from "./classification.questions";
import {
  REVIEW_POLICY_VERSION,
  mapJudgmentsToOutput,
} from "./classification.judgments";
import { AiProviderService } from "../ai-provider/ai-provider.service";
import {
  BreakerOpenError,
  isPerRequestFailure,
} from "../ai-provider/ai-provider.error";

/**
 * Stop a batch after this many consecutive per-email failures (TypeSafe 422
 * rejections and/or `invalid_shape` responses, mixed): one is a bad email,
 * a run of them means the question set or the API contract is probably
 * broken and every remaining request would fail too.
 */
export const MAX_CONSECUTIVE_REJECTIONS = 3;

interface ClassificationAttempt {
  output: EmailClassificationOutput;
  rawResponse: string | null;
  classificationError: string | null;
  providerUsed: string | null;
}

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
    const providerType = await this.aiProviderService.getActiveProviderType();

    // A provider/breaker failure means we never got an answer. Both paths
    // let it propagate and leave the email unclassified for a later run,
    // rather than poisoning it with a fallback classification.
    const { output, rawResponse, classificationError, providerUsed } =
      providerType === "typesafe"
        ? await this.classifyWithTypeSafe(input)
        : await this.classifyWithLlm(normalizedEmailId, input, providerType);

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

  /**
   * TypeSafe (System One) path: structured state + typed questions in one
   * call, answers mapped deterministically by `mapJudgmentsToOutput`.
   *
   * Never writes a fallback row. Every failure propagates and the email
   * stays unclassified for a later run:
   * - provider / breaker / rate-limit errors, as on the LLM path;
   * - `InvalidProviderResponseError` — `unparseable` (non-JSON 2xx: wrong
   *   endpoint, proxy) is systemic and holds the breaker; `invalid_shape`
   *   (schema-invalid JSON or unmappable answers) is per-email. Either way a
   *   fallback row would mark the email done with a useless classification;
   * - `ProviderRequestRejectedError` — a 422 for this email only.
   */
  private async classifyWithTypeSafe(
    input: EmailClassificationInput,
  ): Promise<ClassificationAttempt> {
    const request = buildClassificationJudgeRequest(input);

    // Mapping runs inside the breaker guard so an unmappable answer counts
    // as a provider failure, exactly like a schema-invalid body.
    const { output, rawResponse } = await this.aiProviderService.judgeWith(
      request,
      ({ response, rawBody }) => ({
        output: mapJudgmentsToOutput(response.answers, input).output,
        // Audit envelope: exact body text + the question set and review
        // policy that produced it.
        rawResponse: JSON.stringify({
          questionSetVersion: CLASSIFICATION_QUESTION_SET_VERSION,
          reviewPolicyVersion: REVIEW_POLICY_VERSION,
          model: response.model,
          raw: rawBody,
        }),
      }),
    );

    return {
      output,
      rawResponse,
      classificationError: null,
      providerUsed: "typesafe",
    };
  }

  /** LLM path: free-text prompt → JSON → Zod. */
  private async classifyWithLlm(
    normalizedEmailId: string,
    input: EmailClassificationInput,
    providerType: string | null,
  ): Promise<ClassificationAttempt> {
    const prompt = buildClassificationPrompt(input);

    let classificationError: string | null = null;
    let output: EmailClassificationOutput;
    let providerUsed: string | null = providerType;

    // Reasoning models spend hidden thinking tokens from the same
    // budget; too low a cap truncates the visible JSON mid-string.
    const request: LlmRequest = {
      prompt,
      temperature: 0.3,
      maxTokens: Number(process.env.AI_MAX_TOKENS) || 4000,
    };

    const response = await this.aiProviderService.complete(request);
    const rawResponse = response.content;

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

    return { output, rawResponse, classificationError, providerUsed };
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
      // Newest mail first. Per-email failures write no row, so they stay
      // unclassified; oldest-first would put them at the head of every
      // batch and the consecutive-rejection stop would starve new mail.
      orderBy: [
        { parsedEmail: { rawEmail: { internalDate: "desc" } } },
        { id: "desc" },
      ],
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

    let consecutiveRejections = 0;

    for (const { id } of unclassified) {
      try {
        const classification = await this.classifyEmail(id);
        processed++;
        consecutiveRejections = 0;
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
        // A failure specific to this one email: the provider rejected the
        // request (TypeSafe 422) or answered with an invalid shape. No row
        // is written, so the email is retried next run; carry on with the
        // rest unless such failures keep coming back to back.
        if (isPerRequestFailure(error)) {
          errors++;
          consecutiveRejections++;
          this.logger.warn(
            `Per-email classification failure for normalized email ${id} ` +
              `(${error.name}): ${error.message}`,
          );
          if (consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS) {
            skipped = unclassified.length - processed - errors;
            this.logger.error(
              `${consecutiveRejections} consecutive per-email failures from ` +
                `${error.provider} (latest: ${error.name}); the question set ` +
                `or API contract is probably broken. Stopping batch, ` +
                `deferring ${skipped} email(s)`,
            );
            break;
          }
          continue;
        }
        consecutiveRejections = 0;
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
