import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import {
  EmailCategory,
  ImportanceLevel,
  RecommendedAction,
} from "@email-ai/shared";

export interface DigestEmail {
  id: string;
  subject: string | null;
  fromAddress: string | null;
  fromName: string | null;
  category: EmailCategory;
  importance: ImportanceLevel;
  urgency: string;
  recommendedAction: RecommendedAction;
  reason: string;
  confidence: string;
  receivedAt: Date;
  reviewDecision?: "approved" | "rejected" | null;
}

export interface DigestGroup {
  emails: DigestEmail[];
  count: number;
}

export interface DailyDigest {
  date: string;
  generatedAt: string;
  actionable: DigestGroup;
  fyi: DigestGroup;
  lowValue: DigestGroup;
  summary: {
    totalEmails: number;
    actionableCount: number;
    fyiCount: number;
    lowValueCount: number;
    needsReviewCount: number;
  };
}

export interface GenerateDigestOptions {
  date?: Date;
  outputPath?: string;
  includeUnreviewed?: boolean;
}

@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Generate a daily digest of classified emails.
   * Groups emails into actionable, FYI, and low value categories.
   */
  async generateDigest(
    options: GenerateDigestOptions = {},
  ): Promise<DailyDigest> {
    const { date = new Date() } = options;

    this.logger.log(
      `Generating digest for ${date.toISOString().split("T")[0]}`,
    );

    // Get start and end of the specified date
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    // Fetch classifications for the date range
    const classifications = await this.db.emailClassification.findMany({
      where: {
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      select: {
        id: true,
        category: true,
        importance: true,
        urgency: true,
        recommendedAction: true,
        confidence: true,
        needsReview: true,
        reason: true,
        createdAt: true,
        normalizedEmail: {
          select: {
            senderDomain: true,
            parsedEmail: {
              select: {
                subject: true,
                fromAddress: true,
                fromName: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    this.logger.log(
      `Found ${classifications.length} classifications for digest`,
    );

    // Group emails by category
    const grouped = this.groupEmailsByActionability(classifications);

    const digest: DailyDigest = {
      date: startOfDay.toISOString().split("T")[0],
      generatedAt: new Date().toISOString(),
      actionable: {
        emails: grouped.actionable,
        count: grouped.actionable.length,
      },
      fyi: {
        emails: grouped.fyi,
        count: grouped.fyi.length,
      },
      lowValue: {
        emails: grouped.lowValue,
        count: grouped.lowValue.length,
      },
      summary: {
        totalEmails: classifications.length,
        actionableCount: grouped.actionable.length,
        fyiCount: grouped.fyi.length,
        lowValueCount: grouped.lowValue.length,
        needsReviewCount: classifications.filter((c) => c.needsReview).length,
      },
    };

    return digest;
  }

  /**
   * Group emails into actionable, FYI, and low value categories
   * based on classification data.
   */
  private groupEmailsByActionability(
    classifications: Array<{
      id: string;
      category: string;
      importance: string;
      urgency: string;
      recommendedAction: string;
      confidence: string;
      needsReview: boolean;
      reason: string;
      createdAt: Date;
      normalizedEmail: {
        parsedEmail: {
          subject: string | null;
          fromAddress: string | null;
          fromName: string | null;
        } | null;
      } | null;
    }>,
  ): {
    actionable: DigestEmail[];
    fyi: DigestEmail[];
    lowValue: DigestEmail[];
  } {
    const actionable: DigestEmail[] = [];
    const fyi: DigestEmail[] = [];
    const lowValue: DigestEmail[] = [];

    for (const classification of classifications) {
      const email: DigestEmail = {
        id: classification.id,
        subject: classification.normalizedEmail?.parsedEmail?.subject ?? null,
        fromAddress:
          classification.normalizedEmail?.parsedEmail?.fromAddress ?? null,
        fromName: classification.normalizedEmail?.parsedEmail?.fromName ?? null,
        category: classification.category as EmailCategory,
        importance: classification.importance as ImportanceLevel,
        urgency: classification.urgency,
        recommendedAction:
          classification.recommendedAction as RecommendedAction,
        reason: classification.reason,
        confidence: classification.confidence,
        receivedAt: classification.createdAt,
        reviewDecision: null,
      };

      const group = this.determineActionabilityGroup(email);

      switch (group) {
        case "actionable":
          actionable.push(email);
          break;
        case "fyi":
          fyi.push(email);
          break;
        case "lowValue":
          lowValue.push(email);
          break;
      }
    }

    return { actionable, fyi, lowValue };
  }

  /**
   * Determine which group an email belongs to based on its classification.
   */
  private determineActionabilityGroup(
    email: DigestEmail,
  ): "actionable" | "fyi" | "lowValue" {
    const category = email.category;
    const importance = email.importance;
    const urgency = email.urgency;
    const action = email.recommendedAction;

    // Actionable: requires user action
    // - needs_attention category (always)
    // - personal category with high/critical importance
    // - reply_needed or read_now recommended actions
    // - immediate or today urgency with high importance
    if (
      category === "needs_attention" ||
      (category === "personal" &&
        (importance === "high" || importance === "critical")) ||
      action === "reply_needed" ||
      action === "read_now" ||
      ((urgency === "immediate" || urgency === "today") &&
        importance === "high")
    ) {
      return "actionable";
    }

    // Low Value: can be safely archived/deleted or is low priority
    // - archive or delete categories
    // - social category
    // - low importance with no_action or mark_read
    // - unknown category
    if (
      category === "archive" ||
      category === "delete" ||
      category === "social" ||
      category === "unknown" ||
      (importance === "low" &&
        (action === "no_action" ||
          action === "mark_read" ||
          action === "delete"))
    ) {
      return "lowValue";
    }

    // FYI: everything else (informational, non-urgent)
    // - newsletter, receipt, notification
    // - read_later category
    // - medium/low importance items
    return "fyi";
  }

  /**
   * Generate markdown content for the digest.
   */
  generateMarkdown(digest: DailyDigest): string {
    const lines: string[] = [];

    // Header
    lines.push(`# Email Digest - ${digest.date}`);
    lines.push("");
    lines.push(
      `*Generated at ${new Date(digest.generatedAt).toLocaleString()}*`,
    );
    lines.push("");

    // Summary
    lines.push("## Summary");
    lines.push("");
    lines.push(`- **Total Emails**: ${digest.summary.totalEmails}`);
    lines.push(
      `- **Actionable**: ${digest.summary.actionableCount} items requiring attention`,
    );
    lines.push(`- **FYI**: ${digest.summary.fyiCount} informational items`);
    lines.push(
      `- **Low Value**: ${digest.summary.lowValueCount} items to archive/delete`,
    );
    if (digest.summary.needsReviewCount > 0) {
      lines.push(
        `- **Needs Review**: ${digest.summary.needsReviewCount} items flagged for review`,
      );
    }
    lines.push("");

    // Actionable Section
    lines.push("## Actionable");
    lines.push("");
    if (digest.actionable.count === 0) {
      lines.push("*No actionable items today.*");
    } else {
      for (const email of digest.actionable.emails) {
        lines.push(this.formatEmailLine(email));
      }
    }
    lines.push("");

    // FYI Section
    lines.push("## FYI");
    lines.push("");
    if (digest.fyi.count === 0) {
      lines.push("*No FYI items today.*");
    } else {
      for (const email of digest.fyi.emails) {
        lines.push(this.formatEmailLine(email));
      }
    }
    lines.push("");

    // Low Value Section
    lines.push("## Low Value");
    lines.push("");
    if (digest.lowValue.count === 0) {
      lines.push("*No low value items today.*");
    } else {
      for (const email of digest.lowValue.emails) {
        lines.push(this.formatEmailLine(email));
      }
    }
    lines.push("");

    return lines.join("\n");
  }

  /**
   * Format a single email as a markdown bullet point.
   */
  private formatEmailLine(email: DigestEmail): string {
    const from = email.fromName || email.fromAddress || "Unknown sender";
    const subject = email.subject || "(No subject)";
    const reviewBadge = email.reviewDecision
      ? email.reviewDecision === "approved"
        ? " ✓"
        : " ✗"
      : email.confidence === "low"
        ? " ?"
        : "";

    return `- **${from}** - ${subject}${reviewBadge}`;
  }

  /**
   * Generate markdown and write to file system.
   * Creates idempotent output: same date = same filename.
   */
  async generateAndSaveDigest(
    options: GenerateDigestOptions & { outputPath: string },
  ): Promise<{ digest: DailyDigest; filePath: string }> {
    const { outputPath, date = new Date() } = options;

    // Generate digest
    const digest = await this.generateDigest(options);
    const markdown = this.generateMarkdown(digest);

    // Create idempotent filename based on date
    const dateStr = date.toISOString().split("T")[0];
    const fileName = `email-digest-${dateStr}.md`;
    const filePath = `${outputPath}/${fileName}`;

    // Write to file system (using Node.js fs)
    const fs = await import("fs/promises");

    // Ensure output directory exists
    await fs.mkdir(outputPath, { recursive: true });

    // Write file
    await fs.writeFile(filePath, markdown, "utf-8");

    this.logger.log(`Digest saved to ${filePath}`);

    return { digest, filePath };
  }
}
