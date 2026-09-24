import { Injectable, Logger } from "@nestjs/common";
import { ZodError } from "zod";
import { EmailClassification, NormalizedEmail } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import {
  EmailClassificationInput,
  EmailClassificationOutput,
  EmailClassificationOutputSchema,
  LlmRequest,
  RecommendedAction,
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
import { SenderRulesService } from "../sender-rules/sender-rules.service";
import type {
  MatchableSenderRule,
  SenderRuleMatch,
  SenderRuleMatcher,
} from "../sender-rules/sender-rule-matcher";

/**
 * Stop a batch after this many consecutive per-email failures (TypeSafe 422
 * rejections and/or `invalid_shape` responses, mixed): one is a bad email,
 * a run of them means the question set or the API contract is probably
 * broken and every remaining request would fail too.
 */
export const MAX_CONSECUTIVE_REJECTIONS = 3;

/** `providerUsed` for rows written by a sender rule instead of an AI call. */
export const SENDER_RULE_PROVIDER = "sender-rule";

/**
 * Recommended action for a sender-rule classification, by rule category.
 * `newsletter` is a wanted subscription (mark_read); only `marketing`
 * suggests unsubscribing.
 */
export function senderRuleRecommendedAction(
  category: string,
): RecommendedAction {
  switch (category) {
    case "delete":
      return "delete";
    case "archive":
      return "archive";
    case "marketing":
      return "unsubscribe";
    default:
      return "mark_read";
  }
}

export interface ProcessUnclassifiedResult {
  /** Rows written this run: sender-rule and AI classifications together. */
  processed: number;
  errors: number;
  needsReview: number;
  skipped: number;
  /** Of `processed`, how many a sender rule classified (no AI call). */
  ruleClassified: number;
}

export interface ClassificationAttempt {
  output: EmailClassificationOutput;
  rawResponse: string | null;
  classificationError: string | null;
  providerUsed: string | null;
  senderRuleId?: string | null;
}

/**
 * Sender-rule path: deterministic output from the matched rule. Still
 * validated with EmailClassificationOutputSchema, so a stored rule with a
 * category outside the enum fails loudly (ZodError) instead of writing a
 * bad row. Shared with sender-rule reclassification, so a reclassified row
 * is exactly what classification would have written.
 */
export function buildSenderRuleAttempt({
  rule,
  matchedOn,
}: SenderRuleMatch<MatchableSenderRule>): ClassificationAttempt {
  const output = EmailClassificationOutputSchema.parse({
    category: rule.category,
    importance: "low",
    urgency: "none",
    recommendedAction: senderRuleRecommendedAction(rule.category),
    confidence: "high",
    needsReview: false,
    reason: `Sender rule ${rule.id}: ${rule.matchType} "${rule.pattern}"`.slice(
      0,
      500,
    ),
  });
  return {
    output,
    rawResponse: JSON.stringify({
      ruleId: rule.id,
      matchType: rule.matchType,
      pattern: rule.pattern,
      matchedOn,
    }),
    classificationError: null,
    providerUsed: SENDER_RULE_PROVIDER,
    senderRuleId: rule.id,
  };
}

@Injectable()
export class ClassificationService {
  private readonly logger = new Logger(ClassificationService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly aiProviderService: AiProviderService,
    private readonly senderRulesService: SenderRulesService,
  ) {}

  /**
   * Classify one normalized email. Enabled sender rules are checked first:
   * a match writes the classification directly, with no AI call. `matcher`
   * lets a batch compile the rules once; otherwise the service's cached
   * matcher is used.
   */
  async classifyEmail(
    normalizedEmailId: string,
    matcher?: SenderRuleMatcher<MatchableSenderRule>,
  ): Promise<EmailClassification> {
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

    // Sender rules run before the provider is even looked up: a match
    // costs no AI call and does not depend on the breaker.
    const rules = matcher ?? (await this.senderRulesService.getMatcher());
    const ruleMatch = rules.match({
      fromAddress: normalized.parsedEmail.fromAddress,
      senderDomain: normalized.senderDomain,
    });
    if (ruleMatch) {
      const attempt = this.tryRuleAttempt(normalizedEmailId, ruleMatch);
      // An unusable rule (bad stored category) falls through to AI.
      if (attempt) return this.persist(normalizedEmailId, attempt);
    }

    const input = this.buildInput(normalized);
    const providerType = await this.aiProviderService.getActiveProviderType();

    // A provider/breaker failure means we never got an answer. Both paths
    // let it propagate and leave the email unclassified for a later run,
    // rather than poisoning it with a fallback classification.
    const attempt =
      providerType === "typesafe"
        ? await this.classifyWithTypeSafe(input)
        : await this.classifyWithLlm(normalizedEmailId, input, providerType);

    return this.persist(normalizedEmailId, attempt);
  }

  private persist(
    normalizedEmailId: string,
    {
      output,
      rawResponse,
      classificationError,
      providerUsed,
      senderRuleId = null,
    }: ClassificationAttempt,
  ): Promise<EmailClassification> {
    const data = {
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
      senderRuleId,
    };
    return this.db.emailClassification.upsert({
      where: { normalizedEmailId },
      create: { normalizedEmailId, ...data },
      update: data,
    });
  }

  /**
   * `classifyWithRule`, or null (logged) when the rule's output fails
   * EmailClassificationOutputSchema, e.g. a stored category outside the
   * enum. Other errors propagate.
   */
  private tryRuleAttempt(
    normalizedEmailId: string,
    match: SenderRuleMatch<MatchableSenderRule>,
  ): ClassificationAttempt | null {
    try {
      return this.classifyWithRule(match);
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      this.logger.warn(
        `Sender rule ${match.rule.id} produced an invalid classification for ` +
          `normalized email ${normalizedEmailId} (${error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join(", ")}); falling through to AI`,
      );
      return null;
    }
  }

  /** Sender-rule path: see `buildSenderRuleAttempt`. */
  private classifyWithRule(
    match: SenderRuleMatch<MatchableSenderRule>,
  ): ClassificationAttempt {
    return buildSenderRuleAttempt(match);
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

  async processUnclassified(
    since?: Date,
  ): Promise<ProcessUnclassifiedResult> {
    const candidates = await this.db.normalizedEmail.findMany({
      where: {
        classification: null,
        ...(since && {
          parsedEmail: { rawEmail: { internalDate: { gte: since } } },
        }),
      },
      select: {
        id: true,
        senderDomain: true,
        parsedEmail: { select: { fromAddress: true } },
      },
      // Newest mail first. Per-email failures write no row, so they stay
      // unclassified; oldest-first would put them at the head of every
      // batch and the consecutive-rejection stop would starve new mail.
      orderBy: [
        { parsedEmail: { rawEmail: { internalDate: "desc" } } },
        { id: "desc" },
      ],
    });

    // Sender-rule pass first, over every candidate: it needs no AI call,
    // so it runs even when the breaker is open. Load the rules once: the
    // whole run uses this snapshot, even if rules change mid-run.
    const matcher = await this.senderRulesService.getMatcher();
    let ruleClassified = 0;
    let ruleErrors = 0;
    const unclassified: { id: string }[] = [];

    for (const candidate of candidates) {
      const match =
        matcher.size > 0
          ? matcher.match({
              fromAddress: candidate.parsedEmail?.fromAddress ?? null,
              senderDomain: candidate.senderDomain,
            })
          : null;
      // No match, or a rule whose output is invalid (bad stored category):
      // leave it to the AI loop, which falls through the same way.
      const attempt = match ? this.tryRuleAttempt(candidate.id, match) : null;
      if (!match || !attempt) {
        unclassified.push({ id: candidate.id });
        continue;
      }
      try {
        // Candidates come from the classification: null query, so there
        // is no existing row to return; persist is an upsert regardless.
        await this.persist(candidate.id, attempt);
        ruleClassified++;
      } catch (error) {
        ruleErrors++;
        this.logger.error(
          `Sender rule ${match.rule.id} failed to classify normalized email ${candidate.id}`,
          error,
        );
      }
    }

    if (ruleClassified > 0 || ruleErrors > 0) {
      this.logger.log(
        `Sender rules classified ${ruleClassified} email(s) (${ruleErrors} errors)`,
      );
    }

    // Circuit breaker: if a prior run hit a quota/auth wall, skip the rest
    // of the batch cheaply instead of firing one doomed request per email.
    const breaker = this.aiProviderService.getBreakerStatus();
    if (breaker.open) {
      this.logger.warn(
        `AI breaker open until ${breaker.nextAllowedAttempt} ` +
          `(${breaker.reason ?? "unknown"}); skipping ${unclassified.length} email(s)`,
      );
      return {
        processed: ruleClassified,
        errors: ruleErrors,
        needsReview: 0,
        skipped: unclassified.length,
        ruleClassified,
      };
    }

    let processed = 0;
    let errors = 0;
    let needsReviewCount = 0;
    let skipped = 0;

    let consecutiveRejections = 0;

    for (const { id } of unclassified) {
      try {
        const classification = await this.classifyEmail(id, matcher);
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

    return {
      processed: processed + ruleClassified,
      errors: errors + ruleErrors,
      needsReview: needsReviewCount,
      skipped,
      ruleClassified,
    };
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
    ruleClassified: number;
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
      ruleClassified: 0,
      fallbackClassified: 0,
      needsReview: 0,
      byCategory: {} as Record<string, number>,
    };

    for (const c of allClassifications) {
      const provider = c.providerUsed ?? "unknown";
      stats.byProvider[provider] = (stats.byProvider[provider] ?? 0) + 1;

      if (c.providerUsed === SENDER_RULE_PROVIDER) {
        stats.ruleClassified++;
      } else if (c.providerUsed === "fallback") {
        stats.fallbackClassified++;
      } else if (c.providerUsed) {
        stats.aiClassified++;
      }

      if (c.needsReview) {
        stats.needsReview++;
      }

      stats.byCategory[c.category] = (stats.byCategory[c.category] ?? 0) + 1;
    }

    return stats;
  }
}
