import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  MailboxActionStatus,
  MailboxActionType,
  SenderRule as SenderRuleRow,
} from "@prisma/client";
import {
  SenderRuleApplyAccount,
  SenderRuleApplyQuery,
  SenderRuleApplyResponse,
  SenderRuleApplySample,
} from "@email-ai/shared";
import { AppConfigService } from "../config/config.service";
import { DatabaseService } from "../database/database.service";
import { extractMessageId } from "../mailbox-actions/message-id";
import {
  MailboxWriterService,
  SOURCE_MAILBOX,
  TrashTarget,
  TrashTargetResult,
} from "../mailbox-actions/mailbox-writer.service";
import { compileRules } from "./sender-rule-matcher";

/** RawEmail rows read per page while scanning INBOX for matches. */
const SCAN_PAGE_SIZE = 500;
/** Raw sources loaded per query while selecting (for Message-ID). */
const SOURCE_BATCH_SIZE = 50;
const SAMPLE_SIZE = 10;

interface Candidate {
  rule: SenderRuleRow;
  accountId: string;
  rawEmailId: string;
  uid: number;
  uidValidity: string | null;
  fromAddress: string | null;
  subject: string | null;
  messageId?: string | null;
}

interface Bucket {
  counts: Omit<SenderRuleApplyAccount, "accountId" | "accountLabel" | "sample" | "error">;
  sample: SenderRuleApplySample[];
  error: string | null;
}

/**
 * Applies enabled `trash` sender rules to mail already in INBOX.
 *
 * Dry run (the default): database only, no IMAP connection, no
 * MailboxAction rows; reports what would move. Live (dryRun=false): only
 * when MAILBOX_WRITES_ENABLED is on (otherwise 403, never a silent
 * downgrade), handing the selection to MailboxWriterService.
 */
@Injectable()
export class SenderRulesApplyService {
  private readonly logger = new Logger(SenderRulesApplyService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly writer: MailboxWriterService,
  ) {}

  async apply(query: SenderRuleApplyQuery): Promise<SenderRuleApplyResponse> {
    const writesEnabled = this.config.mailboxWritesEnabled;
    if (!query.dryRun && !writesEnabled) {
      throw new ForbiddenException(
        "Mailbox writes are disabled (MAILBOX_WRITES_ENABLED is not \"true\"); " +
          "use dryRun=true to see what would move",
      );
    }

    // The trash rules this run reports on (just `ruleId` when given)...
    const rules = await this.loadRules(query.ruleId);
    const reported = new Set(rules.map((r) => r.id));
    const accounts = await this.loadAccounts(query.accountId);
    // ...but matching uses EVERY enabled rule, with the same precedence as
    // classification: a message moves only when the rule that wins for its
    // sender is a trash rule (an `address` classify rule inside a `domain`
    // trash rule is an exception that protects that sender).
    const allRules = rules.length
      ? await this.db.senderRule.findMany({
          where: { enabled: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : [];
    const matcher = compileRules(allRules);
    if (matcher.skipped.length) {
      this.logger.warn(`Skipping unsafe/invalid sender rule(s): ${matcher.skipped.join(", ")}`);
    }

    const accountIds = accounts.map((a) => a.id);
    // Mail trashed before and taken back out (undo, or dragged back by hand
    // and re-ingested under a new UID) is never trashed again.
    const trashedBefore = await this.db.mailboxAction.findMany({
      where: {
        accountId: { in: accountIds },
        action: MailboxActionType.move_to_trash,
        status: { in: [MailboxActionStatus.succeeded, MailboxActionStatus.undone] },
      },
      select: { accountId: true, messageId: true, rawEmailId: true, status: true },
    });
    const undoneRawIds = new Set(
      trashedBefore
        .filter((u) => u.status === MailboxActionStatus.undone)
        .map((u) => u.rawEmailId)
        .filter((v): v is string => !!v),
    );
    const undoneMessageIds = new Set(
      trashedBefore.filter((u) => u.messageId).map((u) => `${u.accountId}\u0000${u.messageId}`),
    );

    // Buckets keyed rule → account.
    const buckets = new Map<string, Map<string, Bucket>>(rules.map((r) => [r.id, new Map()]));
    const bucket = (ruleId: string, accountId: string): Bucket => {
      const byAccount = buckets.get(ruleId) as Map<string, Bucket>;
      let b = byAccount.get(accountId);
      if (!b) {
        b = {
          counts: { matched: 0, selected: 0, moved: 0, skipped: 0, failed: 0, unknown: 0 },
          sample: [],
          error: null,
        };
        byAccount.set(accountId, b);
      }
      return b;
    };

    // 1. Scan: every eligible INBOX match (no raw source loaded).
    const candidates: Candidate[] = [];
    if (matcher.size > 0 && rules.length > 0) {
      for (const accountId of accountIds) {
        let cursor: string | undefined;
        for (;;) {
          const page = await this.db.rawEmail.findMany({
            where: {
              accountId,
              mailbox: SOURCE_MAILBOX,
              parsed: { isNot: null },
              // Never re-attempt mail with an in-flight, completed, or
              // skipped (identity could not be confirmed) move. Failed
              // attempts are retried; undone ones are excluded below.
              mailboxActions: {
                none: {
                  action: MailboxActionType.move_to_trash,
                  status: {
                    in: [
                      MailboxActionStatus.pending,
                      MailboxActionStatus.succeeded,
                      MailboxActionStatus.skipped,
                      MailboxActionStatus.unknown,
                    ],
                  },
                },
              },
            },
            select: {
              id: true,
              uid: true,
              uidValidity: true,
              parsed: {
                select: {
                  fromAddress: true,
                  subject: true,
                  normalized: {
                    select: {
                      senderDomain: true,
                      classification: {
                        select: {
                          reviewDecision: { select: { decision: true, correctedCategory: true } },
                        },
                      },
                    },
                  },
                },
              },
            },
            orderBy: { id: "asc" },
            take: SCAN_PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          });
          for (const row of page) {
            if (undoneRawIds.has(row.id) || !row.parsed) continue;
            // The user overrode the classification in review: hands off.
            const review = row.parsed.normalized?.classification?.reviewDecision;
            if (review && (review.decision === "rejected" || review.correctedCategory !== null)) continue;
            const hit = matcher.match({
              fromAddress: row.parsed.fromAddress,
              senderDomain: row.parsed.normalized?.senderDomain ?? null,
            });
            if (!hit || hit.rule.action !== "trash" || !reported.has(hit.rule.id)) continue;
            candidates.push({
              rule: hit.rule,
              accountId,
              rawEmailId: row.id,
              uid: row.uid,
              uidValidity: row.uidValidity,
              fromAddress: row.parsed.fromAddress,
              subject: row.parsed.subject,
            });
          }
          if (page.length < SCAN_PAGE_SIZE) break;
          cursor = page[page.length - 1].id;
        }
      }
    }

    // 2. Select up to `limit` across the whole run, dropping any message
    // trashed before, by Message-ID: restored with undo, or moved and then
    // dragged back by hand in the mail client (re-ingested under a new UID).
    const selected: Candidate[] = [];
    const droppedUndone = new Set<string>();
    for (let i = 0; i < candidates.length && selected.length < query.limit; i += SOURCE_BATCH_SIZE) {
      const batch = candidates.slice(i, i + SOURCE_BATCH_SIZE);
      const sources = await this.db.rawEmail.findMany({
        where: { id: { in: batch.map((c) => c.rawEmailId) } },
        select: { id: true, rawSource: true },
      });
      const byId = new Map(sources.map((s) => [s.id, s.rawSource]));
      for (const c of batch) {
        if (selected.length >= query.limit) break;
        c.messageId = extractMessageId(byId.get(c.rawEmailId));
        if (c.messageId && undoneMessageIds.has(`${c.accountId}\u0000${c.messageId}`)) {
          droppedUndone.add(c.rawEmailId);
          continue;
        }
        selected.push(c);
      }
    }
    if (droppedUndone.size) {
      this.logger.log(`Excluded ${droppedUndone.size} previously trashed message(s)`);
    }

    // `matched` counts every eligible match; previously-trashed exclusions by Message-ID
    // are only known for the rows examined while selecting.
    for (const c of candidates) {
      if (!droppedUndone.has(c.rawEmailId)) bucket(c.rule.id, c.accountId).counts.matched++;
    }
    for (const c of selected) bucket(c.rule.id, c.accountId).counts.selected++;

    // 3. Act.
    if (query.dryRun) {
      for (const c of selected) {
        this.addSample(bucket(c.rule.id, c.accountId), c, { outcome: "would_move", error: null });
      }
    } else {
      for (const account of accounts) {
        const mine = selected.filter((c) => c.accountId === account.id);
        if (mine.length === 0) continue;
        await this.moveAccount(account.id, mine, bucket);
      }
    }

    return this.buildResponse(query, writesEnabled, rules, accounts, buckets);
  }

  private async moveAccount(
    accountId: string,
    mine: Candidate[],
    bucket: (ruleId: string, accountId: string) => Bucket,
  ): Promise<void> {
    const byUid = new Map(mine.map((c) => [c.uid, c]));
    const targets: TrashTarget[] = mine.map((c) => ({
      rawEmailId: c.rawEmailId,
      uid: c.uid,
      uidValidity: c.uidValidity,
      messageId: c.messageId ?? null,
      fromAddress: c.fromAddress,
      subject: c.subject,
      senderRuleId: c.rule.id,
    }));

    let results: TrashTargetResult[];
    let accountError: string | null = null;
    try {
      const outcome = await this.writer.moveToTrash(accountId, targets, { senderRuleId: null });
      results = outcome.results;
      accountError = outcome.error;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      accountError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Account ${accountId}: apply failed: ${accountError}`);
      results = targets.map((t) => ({
        rawEmailId: t.rawEmailId,
        uid: t.uid,
        status: "failed" as const,
        actionId: null,
        error: accountError,
        destUid: null,
      }));
    }

    for (const r of results) {
      const c = byUid.get(r.uid);
      if (!c) continue;
      const b = bucket(c.rule.id, accountId);
      if (r.status === "succeeded") b.counts.moved++;
      else if (r.status === "skipped") b.counts.skipped++;
      else if (r.status === "unknown") b.counts.unknown++;
      else b.counts.failed++;
      if (accountError) b.error = accountError;
      this.addSample(b, c, { outcome: r.status, error: r.error });
    }
  }

  private addSample(
    b: Bucket,
    c: Candidate,
    { outcome, error }: { outcome: SenderRuleApplySample["outcome"]; error: string | null },
  ): void {
    if (b.sample.length >= SAMPLE_SIZE) return;
    b.sample.push({
      rawEmailId: c.rawEmailId,
      fromAddress: c.fromAddress,
      subject: c.subject,
      outcome,
      error,
    });
  }

  private buildResponse(
    query: SenderRuleApplyQuery,
    writesEnabled: boolean,
    rules: SenderRuleRow[],
    accounts: { id: string; label: string }[],
    buckets: Map<string, Map<string, Bucket>>,
  ): SenderRuleApplyResponse {
    const labels = new Map(accounts.map((a) => [a.id, a.label]));
    const totals = { matched: 0, selected: 0, moved: 0, skipped: 0, failed: 0, unknown: 0 };
    const byRule = rules.map((rule) => {
      const byAccount = [...(buckets.get(rule.id) ?? new Map<string, Bucket>()).entries()]
        .filter(([, b]) => b.counts.matched > 0 || b.counts.selected > 0)
        .map(([accountId, b]) => {
          for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += b.counts[k];
          return {
            accountId,
            accountLabel: labels.get(accountId) ?? accountId,
            ...b.counts,
            error: b.error,
            sample: b.sample,
          };
        });
      return { ruleId: rule.id, pattern: rule.pattern, matchType: rule.matchType, byAccount };
    });
    return { dryRun: query.dryRun, writesEnabled, limit: query.limit, totals, byRule };
  }

  private async loadRules(ruleId: string | undefined): Promise<SenderRuleRow[]> {
    if (ruleId) {
      const rule = await this.db.senderRule.findUnique({ where: { id: ruleId } });
      if (!rule) throw new NotFoundException(`Sender rule ${ruleId} not found`);
      if (!rule.enabled || rule.action !== "trash") {
        throw new BadRequestException(`Sender rule ${ruleId} is not an enabled trash rule`);
      }
      return [rule];
    }
    return this.db.senderRule.findMany({
      where: { enabled: true, action: "trash" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  private async loadAccounts(accountId: string | undefined): Promise<{ id: string; label: string }[]> {
    const accounts = await this.db.emailAccount.findMany({
      where: { isActive: true, ...(accountId ? { id: accountId } : {}) },
      select: { id: true, label: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (accountId && accounts.length === 0) {
      throw new NotFoundException(`Active EmailAccount ${accountId} not found`);
    }
    return accounts;
  }
}
