import { randomUUID } from "node:crypto";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, SenderRule as SenderRuleRow } from "@prisma/client";
import { ZodError, z } from "zod";
import {
  ClassificationRevisionAction,
  SenderRuleReclassifyCounts,
  SenderRuleReclassifyQuery,
  SenderRuleReclassifyResponse,
  SenderRuleReclassifySample,
  SenderRuleReclassifyUndoResponse,
} from "@email-ai/shared";
import { DatabaseService } from "../database/database.service";
import { AiProviderService } from "../ai-provider/ai-provider.service";
import {
  AiProviderError,
  BreakerOpenError,
  InvalidProviderResponseError,
  ProviderRequestRejectedError,
} from "../ai-provider/ai-provider.error";
import {
  ClassificationService,
  MAX_CONSECUTIVE_REJECTIONS,
  SENDER_RULE_PROVIDER,
  buildSenderRuleAttempt,
} from "../classification/classification.service";
import {
  SenderRuleMatch,
  SenderRuleMatcher,
  compileRules,
} from "../sender-rules/sender-rule-matcher";

/** Classification rows read per page while scanning. */
const SCAN_PAGE_SIZE = 500;
const SAMPLE_SIZE = 20;

/**
 * Rough per-email TypeSafe cost: ~4.5k input tokens at $0.042 per million.
 * Other providers have no estimate (null).
 */
const AI_COST_PER_CALL_USD: Record<string, number> = {
  typesafe: (4500 * 0.042) / 1_000_000,
};

/**
 * Every EmailClassification value a reclassify can change: stored as
 * ClassificationRevision.previous / next, and compared field by field to
 * detect "changed since" on undo.
 */
const ClassificationSnapshotSchema = z.object({
  category: z.string(),
  importance: z.string(),
  urgency: z.string(),
  recommendedAction: z.string(),
  confidence: z.string(),
  needsReview: z.boolean(),
  reason: z.string(),
  providerUsed: z.string().nullable(),
  senderRuleId: z.string().nullable(),
  rawResponse: z.string().nullable(),
  classificationError: z.string().nullable(),
});
export type ClassificationSnapshot = z.infer<typeof ClassificationSnapshotSchema>;

const SNAPSHOT_FIELDS = Object.keys(
  ClassificationSnapshotSchema.shape,
) as (keyof ClassificationSnapshot)[];

export function snapshotOf(row: ClassificationSnapshot): ClassificationSnapshot {
  const out = {} as Record<string, unknown>;
  for (const f of SNAPSHOT_FIELDS) out[f] = row[f];
  return out as ClassificationSnapshot;
}

export function sameSnapshot(
  a: ClassificationSnapshot,
  b: ClassificationSnapshot,
): boolean {
  return SNAPSHOT_FIELDS.every((f) => a[f] === b[f]);
}

/** Reason written by release=mark_review. */
export function releaseReviewReason(ruleId: string, batchId: string): string {
  return `Sender rule ${ruleId} no longer matches (reclassify ${batchId})`;
}

/**
 * Reason written when a release needed the AI provider but it was not
 * available (breaker open, repeated provider failures, or a failure after
 * the row was deleted): the row is kept and flagged for review instead.
 */
export function aiUnavailableReason(ruleId: string, batchId: string): string {
  return (
    `Sender rule ${ruleId} no longer matches; AI unavailable, flagged for ` +
    `review (reclassify ${batchId})`
  );
}

/**
 * Consecutive per-email provider failures after which a run stops sending
 * AI-dependent releases to the provider (same threshold as classification).
 */
export const MAX_CONSECUTIVE_AI_FAILURES = MAX_CONSECUTIVE_REJECTIONS;

interface Candidate {
  action: ClassificationRevisionAction;
  classificationId: string;
  normalizedEmailId: string;
  fromAddress: string | null;
  subject: string | null;
  previous: ClassificationSnapshot;
  /**
   * update/claim: the rule's output. release: what another winning rule
   * would write (null when the AI provider would decide). mark_review:
   * computed at apply time (it carries the batch id).
   */
  next: ClassificationSnapshot | null;
}

/** Per-run state for AI-dependent releases. */
interface RunState {
  /** Set once the provider is known to be unavailable for this run. */
  aiUnavailable: boolean;
  consecutiveAiFailures: number;
}

/** A conditional write matched no row: changed or reviewed since the scan. */
class StaleRowError extends Error {
  constructor() {
    super("Classification changed since it was read");
    this.name = "StaleRowError";
  }
}

type Tx = Prisma.TransactionClient;

function isPrismaError(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    codes.includes(error.code)
  );
}

/**
 * POST /sender-rules/:id/reclassify and batch undo. Classification rows
 * only: never touches the mailbox. Every change writes a
 * ClassificationRevision in the same transaction as the change. A
 * released email is never left without a classification row.
 */
@Injectable()
export class SenderRuleReclassifyService {
  private readonly logger = new Logger(SenderRuleReclassifyService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly classification: ClassificationService,
    private readonly aiProvider: AiProviderService,
  ) {}

  /**
   * Same precedence as classification (enabled rules only), compiled fresh
   * from the database for every run. SenderRulesService.getMatcher() is a
   * per-process cache: a rule edited through the other API process (dev
   * vs launchd share the database) would not be seen there.
   */
  private async loadMatcher(): Promise<SenderRuleMatcher<SenderRuleRow>> {
    const rules = await this.db.senderRule.findMany({
      where: { enabled: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const matcher = compileRules(rules);
    if (matcher.skipped.length) {
      this.logger.warn(
        `Skipping unsafe/invalid sender rule(s): ${matcher.skipped.join(", ")}`,
      );
    }
    return matcher;
  }

  async reclassify(
    ruleId: string,
    query: SenderRuleReclassifyQuery,
  ): Promise<SenderRuleReclassifyResponse> {
    const rule = await this.db.senderRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new NotFoundException(`Sender rule ${ruleId} not found`);

    // A disabled target rule never wins, so its linked rows all release
    // and scope=matching claims nothing.
    const matcher = await this.loadMatcher();
    const counts: SenderRuleReclassifyCounts = {
      update: 0,
      claim: 0,
      release: 0,
      skippedReviewed: 0,
      unchanged: 0,
      reclassified: 0,
      deferred: 0,
      markedReview: 0,
      errors: 0,
    };

    const { candidates, more } = await this.scan(
      rule,
      matcher,
      query,
      counts,
    );

    const aiProvider = await this.aiProvider.getActiveProviderType();
    const sample: SenderRuleReclassifySample[] = [];
    const run: RunState = {
      aiUnavailable: this.aiProvider.getBreakerStatus().open,
      consecutiveAiFailures: 0,
    };
    let aiCalls = 0;
    let batchId: string | null = null;
    let deferredByAi = false;

    if (query.dryRun) {
      for (const c of candidates) {
        counts[c.action]++;
        let to = c.next;
        if (c.action === "release") {
          if (query.release === "mark_review") {
            to = c.previous;
          } else if (c.next === null) {
            // A released row no other rule covers goes to the AI provider,
            // or is flagged for review if the breaker is open.
            if (run.aiUnavailable) {
              counts.deferred++;
              deferredByAi = true;
              to = c.previous;
            } else {
              aiCalls++;
            }
          }
        }
        this.addSample(sample, c, to);
      }
    } else {
      batchId = randomUUID();
      for (const c of candidates) {
        const result = await this.applyOne(rule, c, query, batchId, matcher, counts, run);
        aiCalls += result.aiCalls;
        if (result.deferred) deferredByAi = true;
        if (result.applied) this.addSample(sample, c, result.to);
      }
      this.logger.log(
        `Reclassify rule ${rule.id} batch ${batchId} (${query.scope}): ` +
          `${counts.update} updated, ${counts.claim} claimed, ${counts.release} released ` +
          `(${counts.reclassified} reclassified, ${counts.deferred} deferred, ` +
          `${counts.markedReview} marked for review), ${counts.errors} errors, ` +
          `${aiCalls} AI call(s)`,
      );
    }

    return {
      dryRun: query.dryRun,
      scope: query.scope,
      release: query.release,
      limit: query.limit,
      batchId,
      counts,
      aiCalls,
      aiProvider,
      aiUnavailable: deferredByAi,
      estimatedAiCostUsd: estimateCost(aiProvider, aiCalls),
      more,
      sample,
    };
  }

  /**
   * Candidates up to `limit`, in id order. `unchanged` and
   * `skippedReviewed` are counted for the rows scanned; once `limit`
   * changes are found the scan stops and `more` is set.
   */
  private async scan(
    rule: SenderRuleRow,
    matcher: SenderRuleMatcher<SenderRuleRow>,
    query: SenderRuleReclassifyQuery,
    counts: SenderRuleReclassifyCounts,
  ): Promise<{ candidates: Candidate[]; more: boolean }> {
    // A disabled rule wins nothing, so only its own rows can change.
    const where: Prisma.EmailClassificationWhereInput =
      query.scope === "matching" && rule.enabled
        ? {}
        : { senderRuleId: rule.id };
    const candidates: Candidate[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await this.db.emailClassification.findMany({
        where,
        select: {
          id: true,
          normalizedEmailId: true,
          category: true,
          importance: true,
          urgency: true,
          recommendedAction: true,
          confidence: true,
          needsReview: true,
          reason: true,
          providerUsed: true,
          senderRuleId: true,
          rawResponse: true,
          classificationError: true,
          reviewDecision: { select: { id: true } },
          normalizedEmail: {
            select: {
              senderDomain: true,
              parsedEmail: { select: { fromAddress: true, subject: true } },
            },
          },
        },
        orderBy: { id: "asc" },
        take: SCAN_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      for (const row of page) {
        const fromAddress = row.normalizedEmail.parsedEmail?.fromAddress ?? null;
        const hit = matcher.match({
          fromAddress,
          senderDomain: row.normalizedEmail.senderDomain,
        });
        const linked = row.senderRuleId === rule.id;
        const wins = hit?.rule.id === rule.id;
        if (!linked && !wins) continue;

        // Never override a human decision.
        if (row.reviewDecision) {
          counts.skippedReviewed++;
          continue;
        }

        const previous = snapshotOf(row);
        let action: ClassificationRevisionAction;
        let next: ClassificationSnapshot | null = null;

        if (wins) {
          const out = this.ruleOutput(hit, row.normalizedEmailId);
          if (!out) {
            counts.errors++;
            continue;
          }
          next = out;
          if (linked && sameSnapshot(previous, next)) {
            counts.unchanged++;
            continue;
          }
          action = linked ? "update" : "claim";
        } else {
          action = "release";
          if (query.release === "mark_review") {
            // Already marked by an earlier run: nothing to do.
            if (
              previous.needsReview &&
              previous.reason.startsWith(`Sender rule ${rule.id} no longer matches`)
            ) {
              counts.unchanged++;
              continue;
            }
          } else if (hit) {
            next = this.ruleOutput(hit, row.normalizedEmailId);
          }
        }

        if (candidates.length >= query.limit) {
          return { candidates, more: true };
        }
        candidates.push({
          action,
          classificationId: row.id,
          normalizedEmailId: row.normalizedEmailId,
          fromAddress,
          subject: row.normalizedEmail.parsedEmail?.subject ?? null,
          previous,
          next,
        });
      }

      if (page.length < SCAN_PAGE_SIZE) break;
      cursor = page[page.length - 1].id;
    }
    return { candidates, more: false };
  }

  /** The row classification's rule path would write, or null (invalid rule). */
  private ruleOutput(
    match: SenderRuleMatch<SenderRuleRow>,
    normalizedEmailId: string,
  ): ClassificationSnapshot | null {
    try {
      const a = buildSenderRuleAttempt(match);
      return {
        ...a.output,
        providerUsed: a.providerUsed,
        senderRuleId: a.senderRuleId ?? null,
        rawResponse: a.rawResponse,
        classificationError: a.classificationError,
      };
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      this.logger.warn(
        `Sender rule ${match.rule.id} produces an invalid classification ` +
          `for normalized email ${normalizedEmailId}; left unchanged`,
      );
      return null;
    }
  }

  private async applyOne(
    rule: SenderRuleRow,
    c: Candidate,
    query: SenderRuleReclassifyQuery,
    batchId: string,
    matcher: SenderRuleMatcher<SenderRuleRow>,
    counts: SenderRuleReclassifyCounts,
    run: RunState,
  ): Promise<{
    applied: boolean;
    to: ClassificationSnapshot | null;
    aiCalls: number;
    deferred: boolean;
  }> {
    const skip = { applied: false, to: null, aiCalls: 0, deferred: false };
    // A release no other rule covers needs the AI provider.
    const aiDependent =
      c.action === "release" && query.release === "reclassify" && c.next === null;

    // update / claim / mark_review, and AI-dependent releases while the AI
    // is unavailable: keep the row and rewrite it (revision + change in
    // one transaction). Deleting would strand the email unclassified.
    if (c.action !== "release" || query.release === "mark_review" || (aiDependent && run.aiUnavailable)) {
      const deferred = c.action === "release" && query.release === "reclassify";
      const next: ClassificationSnapshot =
        c.action === "release"
          ? {
              ...c.previous,
              needsReview: true,
              reason: deferred
                ? aiUnavailableReason(rule.id, batchId)
                : releaseReviewReason(rule.id, batchId),
            }
          : (c.next as ClassificationSnapshot);
      try {
        await this.db.$transaction(async (tx) => {
          await this.lockUnreviewed(tx, c.classificationId);
          await tx.classificationRevision.create({
            data: this.revisionData(rule, c, batchId, {
              status: c.action === "release" ? "marked_review" : "applied",
              next,
            }),
          });
          await this.guardedUpdate(tx, c, next);
        });
      } catch (error) {
        await this.countFailure(c, error, counts);
        return skip;
      }
      counts[c.action]++;
      if (deferred) counts.deferred++;
      else if (c.action === "release") counts.markedReview++;
      return { applied: true, to: next, aiCalls: 0, deferred };
    }

    // release=reclassify: record + delete in one transaction...
    let revisionId: string;
    try {
      revisionId = await this.db.$transaction(async (tx) => {
        await this.lockUnreviewed(tx, c.classificationId);
        const revision = await tx.classificationRevision.create({
          data: this.revisionData(rule, c, batchId, { status: "deferred", next: null }),
        });
        const deleted = await tx.emailClassification.deleteMany({
          where: { id: c.classificationId, ...c.previous, reviewDecision: { is: null } },
        });
        if (deleted.count !== 1) throw new StaleRowError();
        return revision.id;
      });
    } catch (error) {
      await this.countFailure(c, error, counts);
      return skip;
    }
    counts.release++;

    // ...then classify it again through the normal path: rules first, then
    // the active AI provider.
    try {
      const row = await this.classification.classifyEmail(c.normalizedEmailId, matcher);
      const next = snapshotOf(row);
      await this.db.classificationRevision.update({
        where: { id: revisionId },
        data: { status: "reclassified", next },
      });
      counts.reclassified++;
      const viaAi = row.providerUsed !== SENDER_RULE_PROVIDER;
      if (viaAi) run.consecutiveAiFailures = 0;
      return { applied: true, to: next, aiCalls: viaAi ? 1 : 0, deferred: false };
    } catch (error) {
      const aiCall = madeAiCall(error);
      if (error instanceof BreakerOpenError) {
        run.aiUnavailable = true;
      } else if (aiCall && ++run.consecutiveAiFailures >= MAX_CONSECUTIVE_AI_FAILURES) {
        run.aiUnavailable = true;
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Released normalized email ${c.normalizedEmailId} could not be ` +
          `reclassified (batch ${batchId}): ${reason}; restoring it flagged for review`,
      );
      counts.deferred++;
      const restored = await this.restoreFlagged(rule, c, batchId, revisionId);
      return { applied: true, to: restored, aiCalls: aiCall ? 1 : 0, deferred: true };
    }
  }

  /**
   * Classification failed after the row was deleted: put the previous
   * values back (same id), flagged for review, so the email is never left
   * without a classification row. Null if another writer classified the
   * email in the meantime (the revision then stays `deferred`, next null).
   */
  private async restoreFlagged(
    rule: SenderRuleRow,
    c: Candidate,
    batchId: string,
    revisionId: string,
  ): Promise<ClassificationSnapshot | null> {
    const next: ClassificationSnapshot = {
      ...c.previous,
      needsReview: true,
      reason: aiUnavailableReason(rule.id, batchId),
    };
    try {
      await this.db.$transaction(async (tx) => {
        await tx.emailClassification.create({
          data: { id: c.classificationId, normalizedEmailId: c.normalizedEmailId, ...next },
        });
        await tx.classificationRevision.update({
          where: { id: revisionId },
          data: { status: "marked_review", next },
        });
      });
      return next;
    } catch (error) {
      this.logger.error(
        `Could not restore released classification ${c.classificationId} ` +
          `(normalized email ${c.normalizedEmailId}, batch ${batchId})`,
        error,
      );
      return null;
    }
  }

  /**
   * Locks the classification row for the rest of the transaction, then
   * refuses it if it has a ReviewDecision. A concurrent review insert
   * (FK check takes KEY SHARE on this row) waits for the lock, so a review
   * cannot land between this check and the write.
   */
  private async lockUnreviewed(tx: Tx, classificationId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "EmailClassification" WHERE id = ${classificationId} FOR UPDATE`;
    const review = await tx.reviewDecision.findUnique({
      where: { classificationId },
      select: { id: true },
    });
    if (review) throw new StaleRowError();
  }

  /** Rewrites the row only if it is still exactly as scanned and unreviewed. */
  private async guardedUpdate(
    tx: Tx,
    c: Candidate,
    next: ClassificationSnapshot,
  ): Promise<void> {
    const updated = await tx.emailClassification.updateMany({
      where: { id: c.classificationId, ...c.previous, reviewDecision: { is: null } },
      data: next,
    });
    if (updated.count !== 1) throw new StaleRowError();
  }

  private revisionData(
    rule: SenderRuleRow,
    c: Candidate,
    batchId: string,
    { status, next }: { status: "applied" | "deferred" | "marked_review"; next: ClassificationSnapshot | null },
  ): Prisma.ClassificationRevisionUncheckedCreateInput {
    return {
      batchId,
      action: c.action,
      status,
      normalizedEmailId: c.normalizedEmailId,
      classificationId: c.classificationId,
      senderRuleId: rule.id,
      previous: c.previous,
      ...(next ? { next } : {}),
    };
  }

  private async countFailure(
    c: Candidate,
    error: unknown,
    counts: SenderRuleReclassifyCounts,
  ): Promise<void> {
    if (error instanceof StaleRowError) {
      const now = await this.db.emailClassification.findUnique({
        where: { id: c.classificationId },
        select: { reviewDecision: { select: { id: true } } },
      });
      if (now?.reviewDecision) {
        counts.skippedReviewed++;
        return;
      }
    }
    counts.errors++;
    this.logger.error(
      `Reclassify ${c.action} failed for classification ${c.classificationId}`,
      error,
    );
  }

  private addSample(
    sample: SenderRuleReclassifySample[],
    c: Candidate,
    to: ClassificationSnapshot | null,
  ): void {
    if (sample.length >= SAMPLE_SIZE) return;
    sample.push({
      normalizedEmailId: c.normalizedEmailId,
      fromAddress: c.fromAddress,
      subject: c.subject,
      action: c.action,
      from: {
        category: c.previous.category,
        recommendedAction: c.previous.recommendedAction,
        providerUsed: c.previous.providerUsed,
      },
      to: to ? { category: to.category, recommendedAction: to.recommendedAction } : null,
    });
  }

  /**
   * Restores a batch's previous values. A row is restored only if it is
   * still exactly what the batch left (or still unclassified, for a
   * deferred release) and has no ReviewDecision.
   */
  async undoBatch(batchId: string): Promise<SenderRuleReclassifyUndoResponse> {
    const revisions = await this.db.classificationRevision.findMany({
      where: { batchId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (revisions.length === 0) {
      throw new NotFoundException(`Reclassify batch ${batchId} not found`);
    }

    const counts = { restored: 0, conflicts: 0, skippedReviewed: 0, alreadyUndone: 0 };
    for (const rev of revisions) {
      if (rev.undoneAt) {
        counts.alreadyUndone++;
        continue;
      }
      const previous = ClassificationSnapshotSchema.parse(rev.previous);
      const expected =
        rev.next === null ? null : ClassificationSnapshotSchema.parse(rev.next);

      const current = await this.db.emailClassification.findUnique({
        where: { normalizedEmailId: rev.normalizedEmailId },
        include: { reviewDecision: { select: { id: true } } },
      });
      if (current?.reviewDecision) {
        counts.skippedReviewed++;
        continue;
      }
      // `next` is null only for a release whose restore failed (no row
      // left by the batch); everything else left `next`.
      const leftAsBatchLeftIt = expected
        ? !!current && sameSnapshot(snapshotOf(current), expected)
        : !current && rev.status === "deferred";
      if (!leftAsBatchLeftIt) {
        counts.conflicts++;
        continue;
      }

      // The rule a claim took the row from may have been deleted since.
      const restore = { ...previous };
      if (restore.senderRuleId) {
        const exists = await this.db.senderRule.findUnique({
          where: { id: restore.senderRuleId },
          select: { id: true },
        });
        if (!exists) restore.senderRuleId = null;
      }

      try {
        await this.db.$transaction(async (tx) => {
          const marked = await tx.classificationRevision.updateMany({
            where: { id: rev.id, undoneAt: null },
            data: { undoneAt: new Date() },
          });
          if (marked.count !== 1) throw new StaleRowError();
          if (current && expected) {
            await this.lockUnreviewed(tx, current.id);
            const updated = await tx.emailClassification.updateMany({
              where: { id: current.id, ...expected, reviewDecision: { is: null } },
              data: restore,
            });
            if (updated.count !== 1) throw new StaleRowError();
          } else {
            await tx.emailClassification.create({
              data: {
                ...(rev.classificationId ? { id: rev.classificationId } : {}),
                normalizedEmailId: rev.normalizedEmailId,
                ...restore,
              },
            });
          }
        });
        counts.restored++;
      } catch (error) {
        // StaleRow: changed or reviewed since the check above. P2002: the
        // email was classified again meanwhile. P2003: a referenced row
        // (the email, or the rule) is gone. None of these stop the batch.
        if (!(error instanceof StaleRowError) && !isPrismaError(error, "P2002", "P2003")) {
          throw error;
        }
        counts.conflicts++;
      }
    }

    this.logger.log(
      `Undo reclassify batch ${batchId}: ${counts.restored} restored, ` +
        `${counts.conflicts} conflicts, ${counts.skippedReviewed} reviewed since`,
    );
    return { batchId, counts };
  }
}

function estimateCost(provider: string | null, aiCalls: number): number | null {
  if (aiCalls === 0) return 0;
  const perCall = provider ? AI_COST_PER_CALL_USD[provider] : undefined;
  return perCall === undefined ? null : Math.round(aiCalls * perCall * 1e6) / 1e6;
}

/** A classification failure that happened after a provider request was sent. */
function madeAiCall(error: unknown): boolean {
  if (error instanceof BreakerOpenError) return false;
  return (
    error instanceof AiProviderError ||
    error instanceof ProviderRequestRejectedError ||
    error instanceof InvalidProviderResponseError
  );
}
