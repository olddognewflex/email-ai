import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { NormalizedEmail } from "@prisma/client";
import { DatabaseService } from "../database/database.service";
import { EmailNormalizer } from "./email-normalizer.service";
import { RulesEngineService } from "../rules-engine/rules-engine.service";
import { RulesEngineInput } from "@email-ai/shared";

const BULK_SENDER_PATTERNS = [
  "noreply",
  "no-reply",
  "donotreply",
  "bounce",
  "mailer-daemon",
];

function extractSenderDomain(fromAddress: string | null): string {
  if (!fromAddress) return "unknown";
  const atIndex = fromAddress.indexOf("@");
  return atIndex === -1
    ? "unknown"
    : fromAddress.slice(atIndex + 1).toLowerCase();
}

function isBulkSender(fromAddress: string | null): boolean {
  if (!fromAddress) return false;
  const localPart = fromAddress.split("@")[0]?.toLowerCase() ?? "";
  return BULK_SENDER_PATTERNS.some((pattern) => localPart.includes(pattern));
}

function buildTags(
  hasUnsubscribe: boolean,
  isBulk: boolean,
  attachmentCount: number,
): string[] {
  const tags: string[] = [];
  if (hasUnsubscribe) tags.push("newsletter");
  if (isBulk) tags.push("bulk");
  if (attachmentCount > 0) tags.push("has-attachments");
  return tags;
}

@Injectable()
export class NormalizationService {
  private readonly logger = new Logger(NormalizationService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly normalizer: EmailNormalizer,
    private readonly rulesEngine: RulesEngineService,
  ) {}

  async normalizeEmail(parsedEmailId: string): Promise<NormalizedEmail> {
    const parsed = await this.db.parsedEmail.findUnique({
      where: { id: parsedEmailId },
    });
    if (!parsed)
      throw new NotFoundException(`ParsedEmail ${parsedEmailId} not found`);

    // Extract metadata
    const senderDomain = extractSenderDomain(parsed.fromAddress);
    const isNewsletter = parsed.hasUnsubscribe;
    const isBulk = isBulkSender(parsed.fromAddress);
    const tags = buildTags(
      parsed.hasUnsubscribe,
      isBulk,
      parsed.attachmentCount,
    );

    // Normalize content
    const { cleanedText, detectedLinks, unsubscribeLink } =
      this.normalizer.normalize(parsed.textBody, parsed.htmlBody);

    // Run rules engine for pre-classification
    const rulesInput: RulesEngineInput = {
      subject: parsed.subject,
      fromAddress: parsed.fromAddress,
      fromName: parsed.fromName,
      textBody: cleanedText,
      htmlBody: parsed.htmlBody,
      senderDomain,
      isNewsletter,
      isBulk,
      hasUnsubscribe: parsed.hasUnsubscribe,
      unsubscribeLink: unsubscribeLink ?? undefined,
      tags,
    };

    const classification = this.rulesEngine.classify(rulesInput);
    this.logger.debug(
      `Email ${parsedEmailId} classified as ${classification.ruleCategory} ` +
        `(${classification.ruleConfidence}) via rules: ${classification.matchedRules.join(", ")}`,
    );

    return this.db.normalizedEmail.upsert({
      where: { parsedEmailId },
      create: {
        parsedEmailId,
        senderDomain,
        isNewsletter,
        isBulk,
        tags,
        cleanedText,
        detectedLinks: detectedLinks as any,
        unsubscribeLink,
        ruleCategory: classification.ruleCategory,
        ruleConfidence: classification.ruleConfidence,
        ruleReasons: classification.ruleReasons,
      },
      update: {
        cleanedText,
        detectedLinks: detectedLinks as any,
        unsubscribeLink,
        ruleCategory: classification.ruleCategory,
        ruleConfidence: classification.ruleConfidence,
        ruleReasons: classification.ruleReasons,
      },
    });
  }

  async processUnnormalized(): Promise<{ processed: number; errors: number }> {
    const unnormalized = await this.db.parsedEmail.findMany({
      where: { normalized: null },
      select: { id: true },
    });

    let processed = 0;
    let errors = 0;

    for (const { id } of unnormalized) {
      try {
        await this.normalizeEmail(id);
        processed++;
      } catch (error) {
        this.logger.error(`Failed to normalize parsed email ${id}`, error);
        errors++;
      }
    }

    return { processed, errors };
  }

  async reprocessAll(): Promise<{ processed: number; errors: number }> {
    const normalized = await this.db.parsedEmail.findMany({
      where: { normalized: { isNot: null } },
      select: { id: true },
    });

    let processed = 0;
    let errors = 0;

    for (const { id } of normalized) {
      try {
        await this.normalizeEmail(id);
        processed++;
      } catch (error) {
        this.logger.error(`Failed to reprocess parsed email ${id}`, error);
        errors++;
      }
    }

    this.logger.log(
      `Reprocessed ${processed} normalized emails (${errors} errors)`,
    );

    return { processed, errors };
  }
}

export { extractSenderDomain, isBulkSender, buildTags };
