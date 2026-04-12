import { Injectable, Logger } from "@nestjs/common";
import { EmailClassification, NormalizedEmail } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import {
  EmailClassificationInput,
  EmailClassificationOutput,
  EmailClassificationOutputSchema,
} from "@email-ai/shared";
import { buildClassificationPrompt } from "./classification.prompt";
import { LlmProvider, MockLlmProvider } from "./llm.provider";

@Injectable()
export class ClassificationService {
  private readonly logger = new Logger(ClassificationService.name);
  private readonly llmProvider: LlmProvider;

  constructor(private readonly db: DatabaseService) {
    this.llmProvider = new MockLlmProvider();
  }

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

    try {
      const response = await this.llmProvider.complete(prompt);
      rawResponse = response.content;

      if (response.error) {
        throw new Error(`LLM error: ${response.error}`);
      }

      output = this.parseAndValidateResponse(rawResponse);
    } catch (error) {
      this.logger.error(
        `Classification failed for ${normalizedEmailId}:`,
        error,
      );
      classificationError =
        error instanceof Error ? error.message : "Unknown error";
      output = this.createFallbackOutput();
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
      },
    });
  }

  async processUnclassified(): Promise<{
    processed: number;
    errors: number;
    needsReview: number;
  }> {
    const unclassified = await this.db.normalizedEmail.findMany({
      where: { classification: null },
      select: { id: true },
    });

    let processed = 0;
    let errors = 0;
    let needsReviewCount = 0;

    for (const { id } of unclassified) {
      try {
        const classification = await this.classifyEmail(id);
        processed++;
        if (classification.needsReview) {
          needsReviewCount++;
        }
      } catch (error) {
        this.logger.error(`Failed to classify normalized email ${id}`, error);
        errors++;
      }
    }

    this.logger.log(
      `Classified ${processed} emails (${needsReviewCount} need review, ${errors} errors)`,
    );

    return { processed, errors, needsReview: needsReviewCount };
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
}
