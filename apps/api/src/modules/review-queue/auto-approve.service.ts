import { ConflictException, Injectable, Logger } from "@nestjs/common";
import {
  Prisma,
  ReviewDecisionSource,
  ReviewDecisionType,
} from "@prisma/client";
import { AppConfigService } from "../config/config.service";
import { DatabaseService } from "../database/database.service";

/** The classification fields eligibility depends on. */
export interface AutoApproveCandidate {
  id: string;
  category: string;
  confidence: string;
}

/** Any client with `reviewDecision`: the service itself or a transaction. */
type DecisionClient = Pick<Prisma.TransactionClient, "reviewDecision">;

export const BACKFILL_DEFAULT_LIMIT = 500;
export const BACKFILL_MAX_LIMIT = 5000;
const BACKFILL_SAMPLE_SIZE = 20;

export interface AutoApproveBackfillSample {
  classificationId: string;
  category: string;
  subject: string | null;
  fromAddress: string | null;
}

export interface AutoApproveBackfillResult {
  dryRun: boolean;
  enabled: boolean;
  categories: string[];
  limit: number;
  /** Every pending (undecided) eligible classification, before this run. */
  eligible: number;
  /** Of `eligible`, the rows this run selected (at most `limit`). */
  selected: number;
  /** Selected rows by category. */
  byCategory: Record<string, number>;
  /** Auto approvals written (0 on a dry run). */
  approved: number;
  /** Eligible rows left after this run (beyond `limit`). */
  more: boolean;
  sample: AutoApproveBackfillSample[];
  /** Why nothing was written, when that is not obvious from dryRun. */
  note?: string;
}

/**
 * Pure eligibility rule (EMAIL-6): category on the list and confidence
 * exactly "high". `needsReview` is ignored on purpose: TypeSafe's
 * sensitive check flags most newsletters/marketing, and overriding that
 * flag for these categories is the point. Whether a decision already
 * exists is checked separately (the write never overwrites one).
 */
export function isAutoApproveEligible(
  row: Pick<AutoApproveCandidate, "category" | "confidence">,
  categories: readonly string[],
): boolean {
  return row.confidence === "high" && categories.includes(row.category);
}

/**
 * Creates `auto` approvals. The only thing it ever writes is a
 * ReviewDecision row: no mailbox action, no classification change.
 *
 * Human decisions win: every write here is insert-if-absent
 * (ON CONFLICT DO NOTHING on the unique classificationId), so an existing
 * human (or auto) decision is never overwritten, even under a race.
 */
@Injectable()
export class AutoApproveService {
  private readonly logger = new Logger(AutoApproveService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
  ) {}

  get enabled(): boolean {
    return this.config.autoApproveEnabled;
  }

  get categories(): readonly string[] {
    return this.config.autoApproveCategories;
  }

  isEligible(row: Pick<AutoApproveCandidate, "category" | "confidence">): boolean {
    return isAutoApproveEligible(row, this.categories);
  }

  /**
   * Classification-time hook. Writes an `auto` approval when the switch is
   * on, the row is eligible and it has no decision yet. Returns whether a
   * decision was written.
   */
  async applyIfEligible(
    row: AutoApproveCandidate,
    client: DecisionClient = this.db,
  ): Promise<boolean> {
    if (!this.enabled || !this.isEligible(row)) return false;
    const { count } = await client.reviewDecision.createMany({
      data: [autoApproval(row.id)],
      skipDuplicates: true,
    });
    if (count > 0) {
      this.logger.debug(`Auto-approved classification ${row.id} (${row.category})`);
    }
    return count > 0;
  }

  /**
   * Re-evaluates after a classification row was rewritten in place
   * (sender-rule reclassify, undo). `existing` is the row's decision
   * source as read under the row lock; callers never pass a human one.
   *
   * - existing `auto`: kept while the new values are still eligible,
   *   deleted otherwise (or when `flagForReview`).
   * - no decision: approved if eligible and the switch is on, unless
   *   `flagForReview` (the write meant to put it in front of a human).
   */
  async reconcile(
    client: DecisionClient,
    row: AutoApproveCandidate,
    existing: ReviewDecisionSource | null,
    opts: { flagForReview?: boolean } = {},
  ): Promise<"kept" | "removed" | "created" | "none"> {
    const eligible = !opts.flagForReview && this.isEligible(row);
    if (existing === ReviewDecisionSource.auto) {
      if (eligible) return "kept";
      await client.reviewDecision.deleteMany({
        where: { classificationId: row.id, source: ReviewDecisionSource.auto },
      });
      return "removed";
    }
    if (existing !== null || opts.flagForReview) return "none";
    return (await this.applyIfEligible(row, client)) ? "created" : "none";
  }

  /**
   * POST /review/auto-approve: approve existing pending rows. A dry run
   * (the default) only reads. A real run needs the switch on (409
   * otherwise); a dry run with the switch off still previews, flagged.
   */
  async backfill(opts: {
    dryRun: boolean;
    limit: number;
  }): Promise<AutoApproveBackfillResult> {
    const enabled = this.enabled;
    if (!opts.dryRun && !enabled) {
      throw new ConflictException(
        'Auto-approve is disabled (AUTO_APPROVE_ENABLED is not "true"); ' +
          "nothing was approved. Use dryRun=true to preview.",
      );
    }

    const categories = [...this.categories];
    // Only rows waiting in the review queue. Unflagged high-confidence rows
    // never reach the queue, and the old mock-era rows (~163k "receipt")
    // are among them, so approving those would only add noise.
    const where: Prisma.EmailClassificationWhereInput = {
      needsReview: true,
      reviewDecision: null,
      confidence: "high",
      category: { in: categories },
    };

    const [eligible, rows] = await Promise.all([
      this.db.emailClassification.count({ where }),
      this.db.emailClassification.findMany({
        where,
        select: {
          id: true,
          category: true,
          normalizedEmail: {
            select: {
              parsedEmail: { select: { subject: true, fromAddress: true } },
            },
          },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: opts.limit,
      }),
    ]);

    const byCategory: Record<string, number> = {};
    for (const r of rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    const sample = rows.slice(0, BACKFILL_SAMPLE_SIZE).map((r) => ({
      classificationId: r.id,
      category: r.category,
      subject: r.normalizedEmail?.parsedEmail?.subject ?? null,
      fromAddress: r.normalizedEmail?.parsedEmail?.fromAddress ?? null,
    }));

    let approved = 0;
    if (!opts.dryRun && rows.length > 0) {
      // Insert-if-absent: a decision made since the read above (human or
      // auto) is left as it is and not counted.
      const result = await this.db.reviewDecision.createMany({
        data: rows.map((r) => autoApproval(r.id)),
        skipDuplicates: true,
      });
      approved = result.count;
      this.logger.log(
        `Auto-approve backfill: ${approved} approved of ${rows.length} selected ` +
          `(${eligible} eligible before the run)`,
      );
    }

    return {
      dryRun: opts.dryRun,
      enabled,
      categories,
      limit: opts.limit,
      eligible,
      selected: rows.length,
      byCategory,
      approved,
      more: eligible > rows.length,
      sample,
      ...(opts.dryRun && !enabled
        ? {
            note:
              'Auto-approve is disabled (AUTO_APPROVE_ENABLED is not "true"): ' +
              "preview only; a real run would be refused.",
          }
        : {}),
    };
  }
}

function autoApproval(classificationId: string): Prisma.ReviewDecisionCreateManyInput {
  return {
    classificationId,
    decision: ReviewDecisionType.approved,
    source: ReviewDecisionSource.auto,
  };
}
