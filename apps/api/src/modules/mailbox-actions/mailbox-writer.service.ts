import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  EmailAccount,
  MailboxAction,
  MailboxActionStatus,
  MailboxActionType,
  Prisma,
} from '@prisma/client';
import type { CopyResponseObject, ImapFlow } from 'imapflow';
import { AppConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import { EmailAccountsService } from '../email-accounts/email-accounts.service';
import {
  IMAP_CLIENT_FACTORY,
  ImapClientFactory,
} from '../email-sync/imap-client.factory';
import {
  EnvelopeInfo,
  assertValidUids,
  fetchEnvelope,
  findInMailbox,
  findServerTrash,
  isValidUid,
  presentUids,
  relinkRawEmail,
  searchByMessageId,
  selectedUidValidity,
  uidValidityOf,
} from './imap-lookup';
import { normalizeMessageId, sameMessageId } from './message-id';

// Re-exported for callers and tests that import them from the writer.
export { assertValidUids, findServerTrash } from './imap-lookup';

/**
 * THE ONLY CODE IN THIS REPO THAT MUTATES A MAILBOX.
 *
 * It does exactly two things, both IMAP `UID MOVE`:
 *   - moveToTrash: INBOX → the server-advertised \Trash folder
 *   - restore:     that \Trash folder → INBOX (undo of a move)
 *
 * It never flags, never expunges, never permanently deletes. imapflow's
 * messageMove silently emulates MOVE with COPY + flag + EXPUNGE when the
 * server lacks the MOVE extension, so the MOVE capability is a hard
 * precondition for every call.
 *
 * Every call is gated by MAILBOX_WRITES_ENABLED (checked before any
 * credential is decrypted or client built) and audited in MailboxAction:
 * rows are written before the IMAP command and updated after it.
 */

/** Only INBOX is ever a move source (and the only restore destination). */
export const SOURCE_MAILBOX = 'INBOX';
/** UIDs per UID MOVE command. */
export const MOVE_CHUNK_SIZE = 50;

export const SKIP_UIDVALIDITY_CHANGED = 'uidvalidity_changed';
export const SKIP_IDENTITY_UNVERIFIED = 'identity_unverified';
export const SKIP_MESSAGE_ID_MISMATCH = 'messageid_mismatch';
export const SKIP_NOT_FOUND = 'not_found_in_source';
/** Already has a pending/succeeded move (no row written for this). */
export const SKIP_IN_PROGRESS = 'already_in_progress';
/** The same Message-ID was trashed before and taken back out: never re-trash. */
export const SKIP_PREVIOUSLY_TRASHED = 'previously_trashed';

/** Statuses the one-active-move partial unique indexes treat as active. */
export const ACTIVE_MOVE_STATUSES: MailboxActionStatus[] = [
  MailboxActionStatus.pending,
  MailboxActionStatus.succeeded,
  MailboxActionStatus.unknown,
];

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

export const REFUSE_NO_MOVE = 'server lacks MOVE';
export const REFUSE_NO_TRASH =
  'no server-advertised \\Trash folder (SPECIAL-USE extension)';

export interface TrashTarget {
  rawEmailId: string | null;
  uid: number;
  /** RawEmail.uidValidity: decimal string, or null if unknown. */
  uidValidity: string | null;
  /** Message-ID from the stored raw headers, or null if unknown. */
  messageId: string | null;
  fromAddress: string | null;
  subject: string | null;
  /** Overrides ctx.senderRuleId for this target. */
  senderRuleId?: string | null;
}

export interface MoveToTrashContext {
  senderRuleId: string | null;
}

export type TargetOutcome = 'succeeded' | 'failed' | 'skipped' | 'unknown';

export interface TrashTargetResult {
  rawEmailId: string | null;
  uid: number;
  status: TargetOutcome;
  /** MailboxAction row id; null when no row was written (refusals). */
  actionId: string | null;
  error: string | null;
  destUid: number | null;
}

export interface MoveToTrashResult {
  accountId: string;
  trashMailbox: string | null;
  /** Set when the account was refused or the run aborted part-way. */
  error: string | null;
  results: TrashTargetResult[];
}

export interface RestoreResult {
  original: MailboxAction;
  restore: MailboxAction;
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

@Injectable()
export class MailboxWriterService {
  private readonly logger = new Logger(MailboxWriterService.name);
  /**
   * Accounts with a write in progress in this process. Two overlapping
   * runs could otherwise verify the same UIDs and both issue the MOVE.
   * (Not shared across processes: the dev API and the launchd API are
   * separate; the identity checks still keep a second run from moving a
   * different message.)
   */
  private readonly busy = new Set<string>();

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly emailAccounts: EmailAccountsService,
    @Inject(IMAP_CLIENT_FACTORY)
    private readonly createClient: ImapClientFactory,
  ) {}

  get writesEnabled(): boolean {
    return this.config.mailboxWritesEnabled;
  }

  /**
   * Moves INBOX messages to the server-advertised \Trash folder. Targets
   * whose identity cannot be confirmed are skipped, never moved.
   */
  async moveToTrash(
    accountId: string,
    targets: readonly TrashTarget[],
    ctx: MoveToTrashContext,
  ): Promise<MoveToTrashResult> {
    // (1) Kill switch, before anything else.
    this.assertWritesEnabled();
    // (2) Account usable.
    const account = await this.loadWritableAccount(accountId);
    // (3) UIDs are positive integers, passed on as number[] only.
    assertValidUids(targets.map((t) => t.uid));

    if (targets.length === 0) {
      return { accountId, trashMailbox: null, error: null, results: [] };
    }

    this.acquire(accountId);
    try {
      return await this.moveToTrashLocked(account, targets, ctx);
    } finally {
      this.busy.delete(accountId);
    }
  }

  private async moveToTrashLocked(
    account: EmailAccount,
    targets: readonly TrashTarget[],
    ctx: MoveToTrashContext,
  ): Promise<MoveToTrashResult> {
    const accountId = account.id;
    const credentials = await this.emailAccounts.getImapCredentials(accountId);
    const client = this.createClient(account, credentials);
    const results: TrashTargetResult[] = [];
    let trashPath: string | null = null;
    let runError: string | null = null;

    try {
      await client.connect();

      // (4) Real MOVE only: without it imapflow falls back to a
      // copy-then-expunge emulation, which this service must never issue.
      if (!client.capabilities.has('MOVE')) {
        return this.refuseAll(accountId, targets, REFUSE_NO_MOVE);
      }

      // (5) Destination must be the server-advertised \Trash.
      const trash = findServerTrash(await client.list());
      if (!trash || trash.path.toUpperCase() === SOURCE_MAILBOX) {
        return this.refuseAll(accountId, targets, REFUSE_NO_TRASH);
      }
      trashPath = trash.path;
      const gmail = client.capabilities.has('X-GM-EXT-1');

      // (6) Lock the source mailbox for the whole run.
      const lock = await client.getMailboxLock(SOURCE_MAILBOX);
      try {
        const currentUidValidity = selectedUidValidity(client);

        for (const batch of chunk(targets, MOVE_CHUNK_SIZE)) {
          if (runError) {
            for (const t of batch) {
              results.push(this.result(t, 'failed', null, `aborted: ${runError}`));
            }
            continue;
          }
          try {
            await this.moveChunk(results, client, accountId, batch, trash.path, currentUidValidity, gmail, ctx);
          } catch (error) {
            runError = errorMessage(error);
            this.logger.error(`Account ${accountId}: move to Trash aborted: ${runError}`);
            // Targets of this chunk that have no result yet.
            const done = new Set(results.map((r) => r.uid));
            for (const t of batch) {
              if (!done.has(t.uid)) results.push(this.result(t, 'failed', null, runError));
            }
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await this.closeClient(client);
    }

    const counts = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    this.logger.log(
      `Account ${accountId}: move to ${trashPath}: ${JSON.stringify(counts)}`,
    );
    return { accountId, trashMailbox: trashPath, error: runError, results };
  }

  /**
   * One UID MOVE of at most MOVE_CHUNK_SIZE messages: verify identity (7),
   * write audit rows, move, record the outcome. Pushes each target's
   * result onto `results` as soon as it is final, so a throw part-way
   * leaves the caller with an accurate record of what was written.
   */
  private async moveChunk(
    results: TrashTargetResult[],
    client: ImapFlow,
    accountId: string,
    batch: readonly TrashTarget[],
    trashPath: string,
    currentUidValidity: string | null,
    gmail: boolean,
    ctx: MoveToTrashContext,
  ): Promise<void> {
    const skipped: { target: TrashTarget; reason: string; env?: EnvelopeInfo }[] = [];
    const toFetch: TrashTarget[] = [];

    for (const t of batch) {
      if (t.uidValidity !== null && t.uidValidity !== currentUidValidity) {
        skipped.push({ target: t, reason: SKIP_UIDVALIDITY_CHANGED });
      } else if (normalizeMessageId(t.messageId) === null && t.uidValidity === null) {
        skipped.push({ target: t, reason: SKIP_IDENTITY_UNVERIFIED });
      } else {
        toFetch.push(t);
      }
    }

    const envelopes = new Map<number, EnvelopeInfo>();
    if (toFetch.length > 0) {
      for await (const msg of client.fetch(
        toFetch.map((t) => t.uid),
        { uid: true, envelope: true, ...(gmail ? { labels: true } : {}) },
        { uid: true },
      )) {
        envelopes.set(msg.uid, {
          messageId: normalizeMessageId(msg.envelope?.messageId),
          labels: msg.labels ? [...msg.labels].sort() : [],
        });
      }
    }

    const verified: { target: TrashTarget; env: EnvelopeInfo }[] = [];
    for (const t of toFetch) {
      const env = envelopes.get(t.uid);
      if (!env) {
        skipped.push({ target: t, reason: SKIP_NOT_FOUND });
      } else if (normalizeMessageId(t.messageId) !== null && !sameMessageId(t.messageId, env.messageId)) {
        skipped.push({ target: t, reason: SKIP_MESSAGE_ID_MISMATCH, env });
      } else {
        // Identity confirmed by Message-ID, or (no stored Message-ID) by an
        // unchanged UIDVALIDITY: a UID is never reused within one.
        verified.push({ target: t, env });
      }
    }

    const base = (t: TrashTarget, env?: EnvelopeInfo) => ({
      action: MailboxActionType.move_to_trash,
      accountId,
      rawEmailId: t.rawEmailId,
      senderRuleId: t.senderRuleId !== undefined ? t.senderRuleId : ctx.senderRuleId,
      sourceMailbox: SOURCE_MAILBOX,
      sourceUid: t.uid,
      sourceUidValidity: currentUidValidity,
      messageId: normalizeMessageId(t.messageId) ?? env?.messageId ?? null,
      fromAddress: t.fromAddress,
      subject: t.subject,
      gmailLabels: env?.labels ?? [],
    });

    // (8) What the audit log already says about these messages.
    //  - an ACTIVE move (pending/succeeded/unknown) for the same RawEmail or
    //    the same UID under this UIDVALIDITY: another run (the dev and
    //    launchd APIs share the database) owns it → already_in_progress;
    //  - a succeeded or undone move of the same Message-ID on this account:
    //    the user took it back out of Trash (undo, or by hand in their mail
    //    client) → previously_trashed, never re-trashed.
    if (verified.length > 0) {
      const midOf = (v: { target: TrashTarget; env: EnvelopeInfo }) =>
        normalizeMessageId(v.target.messageId) ?? v.env.messageId;
      const rawIds = verified.map((v) => v.target.rawEmailId).filter((id): id is string => !!id);
      const mids = verified.map(midOf).filter((m): m is string => !!m);
      const prior = await this.db.mailboxAction.findMany({
        where: {
          accountId,
          action: MailboxActionType.move_to_trash,
          OR: [
            ...(rawIds.length ? [{ status: { in: ACTIVE_MOVE_STATUSES }, rawEmailId: { in: rawIds } }] : []),
            ...(currentUidValidity !== null
              ? [
                  {
                    status: { in: ACTIVE_MOVE_STATUSES },
                    sourceUid: { in: verified.map((v) => v.target.uid) },
                    sourceUidValidity: currentUidValidity,
                  },
                ]
              : []),
            ...(mids.length
              ? [{ status: { in: [MailboxActionStatus.succeeded, MailboxActionStatus.undone] }, messageId: { in: mids } }]
              : []),
          ],
        },
        select: { rawEmailId: true, sourceUid: true, sourceUidValidity: true, status: true, messageId: true },
      });
      if (prior.length > 0) {
        const active = prior.filter((p) => (ACTIVE_MOVE_STATUSES as string[]).includes(p.status));
        const trashedMids = new Set(
          prior
            .filter((p) => p.status === MailboxActionStatus.succeeded || p.status === MailboxActionStatus.undone)
            .map((p) => p.messageId),
        );
        for (let i = verified.length - 1; i >= 0; i--) {
          const v = verified[i];
          const t = v.target;
          const inProgress = active.some(
            (p) =>
              (t.rawEmailId !== null && p.rawEmailId === t.rawEmailId) ||
              (p.sourceUid === t.uid && p.sourceUidValidity === currentUidValidity),
          );
          if (inProgress) {
            results.push(this.result(t, 'skipped', null, SKIP_IN_PROGRESS));
            verified.splice(i, 1);
          } else {
            const mid = midOf(v);
            if (mid && trashedMids.has(mid)) {
              skipped.push({ target: t, reason: SKIP_PREVIOUSLY_TRASHED, env: v.env });
              verified.splice(i, 1);
            }
          }
        }
      }
    }

    if (skipped.length > 0) {
      const rows = await this.db.mailboxAction.createManyAndReturn({
        data: skipped.map(({ target, reason, env }) => ({
          ...base(target, env),
          status: MailboxActionStatus.skipped,
          error: reason,
        })),
        select: { id: true, sourceUid: true },
      });
      const ids = new Map(rows.map((r) => [r.sourceUid, r.id]));
      for (const { target, reason } of skipped) {
        results.push(this.result(target, 'skipped', ids.get(target.uid) ?? null, reason));
      }
    }

    if (verified.length === 0) return;

    // Write-ahead, one row at a time: the partial unique index
    // (one active move per message) rejects a row another process
    // already holds with P2002, which only skips that message.
    const pendingIds = new Map<number, string>();
    const toMove: { target: TrashTarget; env: EnvelopeInfo }[] = [];
    try {
      for (const v of verified) {
        try {
          const row = await this.db.mailboxAction.create({
            data: { ...base(v.target, v.env), status: MailboxActionStatus.pending, destMailbox: trashPath },
            select: { id: true },
          });
          pendingIds.set(v.target.uid, row.id);
          toMove.push(v);
        } catch (error) {
          if (isPrismaCode(error, 'P2002')) {
            results.push(this.result(v.target, 'skipped', null, SKIP_IN_PROGRESS));
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      // Nothing was moved: close the rows written so far.
      const message = `not moved: audit insert failed: ${errorMessage(error)}`;
      if (pendingIds.size > 0) {
        await this.db.mailboxAction.updateMany({
          where: { id: { in: [...pendingIds.values()] } },
          data: { status: MailboxActionStatus.failed, error: message },
        });
      }
      for (const { target } of toMove) {
        results.push(this.result(target, 'failed', pendingIds.get(target.uid) ?? null, message));
      }
      throw error;
    }
    if (toMove.length === 0) return;

    const uids = toMove.map(({ target }) => target.uid);

    // Defense in depth: re-assert MOVE right before the call, whatever
    // code may later be added between the connect-time check and here.
    this.assertMoveCapability(client);

    let moved: CopyResponseObject | false | undefined;
    let moveError: unknown = null;
    try {
      moved = await client.messageMove(uids, trashPath, { uid: true });
    } catch (error) {
      moveError = error;
      moved = false;
    }

    type Outcome = { status: 'succeeded' | 'failed' | 'unknown'; destUid: number | null; error: string | null };
    const outcomes = new Map<number, Outcome>();
    if (moved && moved.uidMap) {
      for (const uid of uids) {
        const destUid = moved.uidMap.get(uid) ?? null;
        // COPYUID was reported but did not include this UID: the server
        // did not move it (for example it vanished after the fetch).
        outcomes.set(
          uid,
          destUid !== null
            ? { status: 'succeeded', destUid, error: null }
            : { status: 'failed', destUid: null, error: 'not moved: UID absent from COPYUID response' },
        );
      }
    } else {
      // No COPYUID. Normal for a server without UIDPLUS, but ambiguous when
      // messageMove returned false or threw (imapflow returns false also
      // when the connection drops after the server ran the MOVE) or when a
      // UIDPLUS server sent none. Decide by what is still in INBOX.
      const what = moveError
        ? `UID MOVE threw (${errorMessage(moveError)})`
        : moved
          ? 'UID MOVE reported no COPYUID'
          : 'UID MOVE returned false';
      let remaining: Set<number> | null = null;
      let recheckError: unknown = null;
      try {
        remaining = await presentUids(client, uids);
      } catch (error) {
        recheckError = error;
      }
      const uidplus = client.capabilities.has('UIDPLUS');
      for (const uid of uids) {
        if (remaining === null) {
          outcomes.set(uid, {
            status: 'unknown',
            destUid: null,
            error: `outcome unknown: ${what}; re-check failed (${errorMessage(recheckError)}). Resolve with POST /mailbox-actions/reconcile`,
          });
        } else if (remaining.has(uid)) {
          outcomes.set(uid, { status: 'failed', destUid: null, error: `not moved: ${what}; message still in INBOX` });
        } else if (!moved) {
          outcomes.set(uid, {
            status: 'succeeded',
            destUid: null,
            error: `${what}, but the message left INBOX (confirmed by re-check)`,
          });
        } else if (uidplus) {
          outcomes.set(uid, {
            status: 'failed',
            destUid: null,
            error: 'not moved: no COPYUID from a UIDPLUS server; message no longer in INBOX (moved or removed elsewhere)',
          });
        } else {
          outcomes.set(uid, { status: 'succeeded', destUid: null, error: null });
        }
      }
    }

    const destUidValidity = moved ? uidValidityOf(moved.uidValidity) : null;
    const statusOf = {
      succeeded: MailboxActionStatus.succeeded,
      failed: MailboxActionStatus.failed,
      unknown: MailboxActionStatus.unknown,
    } as const;
    try {
      await this.db.$transaction(
        toMove.map(({ target }) => {
          const o = outcomes.get(target.uid) as Outcome;
          return this.db.mailboxAction.update({
            where: { id: pendingIds.get(target.uid) as string },
            data:
              o.status === 'succeeded'
                ? {
                    status: MailboxActionStatus.succeeded,
                    destMailbox: trashPath,
                    destUid: o.destUid,
                    destUidValidity: o.destUid !== null ? destUidValidity : null,
                    error: o.error,
                  }
                : { status: statusOf[o.status], error: o.error },
          });
        }),
      );
    } catch (error) {
      // The MOVE happened (or may have) but its outcome is not recorded:
      // the rows stay `pending` (never retried by apply; see reconcile).
      const note = `audit update failed: ${errorMessage(error)}`;
      for (const { target } of toMove) {
        const o = outcomes.get(target.uid) as Outcome;
        results.push(
          this.result(target, o.status, pendingIds.get(target.uid) ?? null, o.error ? `${o.error}; ${note}` : note, o.destUid),
        );
      }
      throw error;
    }

    for (const { target } of toMove) {
      const o = outcomes.get(target.uid) as Outcome;
      results.push(this.result(target, o.status, pendingIds.get(target.uid) ?? null, o.error, o.destUid));
    }
    // A thrown MOVE usually means a broken connection: stop this run.
    if (moveError) throw moveError;
  }

  /**
   * Undo a succeeded move_to_trash: move the message from the Trash folder
   * back to INBOX. Gmail labels recorded on the original are not re-applied.
   */
  async restore(actionId: string): Promise<RestoreResult> {
    this.assertWritesEnabled();

    const original = await this.db.mailboxAction.findUnique({ where: { id: actionId } });
    if (!original) throw new NotFoundException(`Mailbox action ${actionId} not found`);
    if (original.action !== MailboxActionType.move_to_trash) {
      throw new ConflictException(`Mailbox action ${actionId} is a ${original.action}; only move_to_trash can be undone`);
    }
    if (original.status !== MailboxActionStatus.succeeded) {
      throw new ConflictException(
        `Mailbox action ${actionId} is ${original.status}; only a succeeded move can be undone`,
      );
    }
    if (!original.destMailbox || original.sourceMailbox !== SOURCE_MAILBOX) {
      throw new ConflictException(`Mailbox action ${actionId} has no restorable source/destination`);
    }
    const account = await this.loadWritableAccount(original.accountId);

    this.acquire(account.id);
    try {
      return await this.restoreLocked(original, account);
    } finally {
      this.busy.delete(account.id);
    }
  }

  private async restoreLocked(
    original: MailboxAction,
    account: EmailAccount,
  ): Promise<RestoreResult> {
    const actionId = original.id;
    const trashPath = original.destMailbox as string;

    // Atomic claim: exactly one caller moves the status off `succeeded`.
    const claim = await this.db.mailboxAction.updateMany({
      where: { id: actionId, status: MailboxActionStatus.succeeded },
      data: { status: MailboxActionStatus.pending },
    });
    if (claim.count === 0) {
      throw new ConflictException(`Mailbox action ${actionId} is already being undone or was undone`);
    }

    // `sent` flips once the UID MOVE is issued: from then on the original
    // is never put back to `succeeded` automatically.
    let sent = false;
    let restoreRowId: string | null = null;
    let restoredUid: number | null = null;
    let restoredUidValidity: string | null = null;
    let restoreNote: string | null = null;
    let result: RestoreResult;

    try {
      const credentials = await this.emailAccounts.getImapCredentials(account.id);
      const client = this.createClient(account, credentials);
      try {
        await client.connect();
        if (!client.capabilities.has('MOVE')) {
          throw new BadGatewayException(`Cannot restore: ${REFUSE_NO_MOVE}`);
        }

        const lock = await client.getMailboxLock(trashPath);
        try {
          const trashUidValidity = selectedUidValidity(client);
          const uid = await this.locateInTrash(client, original, trashUidValidity);
          if (uid === null) {
            throw new BadGatewayException(`Message for action ${actionId} not found in ${trashPath}`);
          }
          assertValidUids([uid]);

          const row = await this.db.mailboxAction.create({
            data: {
              action: MailboxActionType.restore,
              status: MailboxActionStatus.pending,
              accountId: original.accountId,
              rawEmailId: original.rawEmailId,
              senderRuleId: original.senderRuleId,
              sourceMailbox: trashPath,
              sourceUid: uid,
              sourceUidValidity: trashUidValidity,
              destMailbox: original.sourceMailbox,
              // Linked from the start, so reconcile can find the original
              // of a stuck restore. Cleared again if nothing moved.
              undoOfId: original.id,
              messageId: original.messageId,
              fromAddress: original.fromAddress,
              subject: original.subject,
              gmailLabels: [],
            },
          });
          restoreRowId = row.id;

          this.assertMoveCapability(client);
          sent = true;
          let moved: CopyResponseObject | false | undefined;
          let moveError: unknown = null;
          try {
            moved = await client.messageMove([uid], original.sourceMailbox, { uid: true });
          } catch (error) {
            moveError = error;
            moved = false;
          }

          const copyUid = moved && moved.uidMap ? (moved.uidMap.get(uid) ?? null) : null;
          if (copyUid === null) {
            // No COPYUID for this UID. Normal without UIDPLUS, but a throw or
            // false can also mean the connection dropped after the server ran
            // the MOVE, and a UIDPLUS OK without COPYUID means nothing moved.
            // Decide by whether the message is still in Trash.
            const what = moveError
              ? `UID MOVE threw (${errorMessage(moveError)})`
              : moved
                ? 'UID MOVE reported no COPYUID'
                : 'UID MOVE returned false';
            let stillThere: boolean;
            try {
              stillThere = (await presentUids(client, [uid])).has(uid);
            } catch (error) {
              // Outcome unknown: the original stays claimed (pending) and
              // the restore row keeps undoOfId, for reconcile.
              await this.db.mailboxAction.update({
                where: { id: row.id },
                data: {
                  status: MailboxActionStatus.unknown,
                  error: `outcome unknown: ${what}; re-check failed (${errorMessage(error)}). Resolve with POST /mailbox-actions/reconcile`,
                },
              });
              throw new BadGatewayException(
                `Restore outcome unknown for action ${actionId}; run POST /mailbox-actions/reconcile`,
              );
            }
            if (stillThere) {
              sent = false; // nothing moved
              await this.markRestoreFailed(row.id, `not moved: ${what}; message still in Trash`);
              throw new BadGatewayException(`IMAP MOVE back to ${original.sourceMailbox} failed`);
            }
            if (moveError || !moved || client.capabilities.has('UIDPLUS')) {
              restoreNote = `${what}, but the message left Trash (confirmed by re-check)`;
            }
          }
          restoredUid = copyUid;
          restoredUidValidity = copyUid !== null && moved ? uidValidityOf(moved.uidValidity) : null;
        } finally {
          lock.release();
        }

        // No UIDPLUS: find the restored copy by Message-ID (best effort).
        if (restoredUid === null && original.messageId) {
          ({ uid: restoredUid, uidValidity: restoredUidValidity } = await findInMailbox(
            client,
            original.sourceMailbox,
            original.messageId,
          ).catch(() => ({ uid: null, uidValidity: restoredUidValidity })));
        }
      } finally {
        await this.closeClient(client);
      }

      const now = new Date();
      const [restore, updatedOriginal] = await this.db.$transaction([
        this.db.mailboxAction.update({
          where: { id: restoreRowId as string },
          data: {
            status: MailboxActionStatus.succeeded,
            destUid: restoredUid,
            destUidValidity: restoredUidValidity,
            error: restoreNote,
          },
        }),
        this.db.mailboxAction.update({
          where: { id: original.id },
          data: { status: MailboxActionStatus.undone, undoneAt: now },
        }),
      ]);
      result = { original: updatedOriginal, restore };
    } catch (error) {
      if (!sent) {
        // Nothing moved: release the claim so the undo can be retried.
        await this.db.mailboxAction
          .updateMany({
            where: { id: original.id, status: MailboxActionStatus.pending },
            data: { status: MailboxActionStatus.succeeded },
          })
          .catch((e) => this.logger.error(`Could not release claim on ${original.id}: ${errorMessage(e)}`));
      } else {
        this.logger.error(
          `Restore of ${original.id} left pending: the MOVE was sent but its outcome was not recorded (${errorMessage(error)})`,
        );
      }
      throw error;
    }

    // Recorded. The relink is best effort and must not turn a completed
    // undo into an error.
    try {
      await relinkRawEmail(this.db, this.logger, original, restoredUid, restoredUidValidity);
    } catch (error) {
      this.logger.error(`RawEmail relink after restore of ${original.id} failed: ${errorMessage(error)}`);
    }
    this.logger.log(
      `Restored action ${original.id} (${trashPath} → ${original.sourceMailbox}, uid ${restoredUid ?? 'unknown'})`,
    );
    return result;
  }

  /** UID of the original's message in the (locked) Trash folder, verified. */
  private async locateInTrash(
    client: ImapFlow,
    original: MailboxAction,
    trashUidValidity: string | null,
  ): Promise<number | null> {
    const wantId = normalizeMessageId(original.messageId);

    if (
      isValidUid(original.destUid) &&
      original.destUidValidity !== null &&
      original.destUidValidity === trashUidValidity
    ) {
      const env = await fetchEnvelope(client, original.destUid);
      if (env && (wantId === null || sameMessageId(wantId, env.messageId))) {
        return original.destUid;
      }
    }

    if (wantId === null) return null;
    return searchByMessageId(client, wantId);
  }

  private assertMoveCapability(client: ImapFlow): void {
    if (!client.capabilities.has('MOVE')) {
      throw new BadGatewayException(REFUSE_NO_MOVE);
    }
  }

  private acquire(accountId: string): void {
    if (this.busy.has(accountId)) {
      throw new ConflictException(
        `A mailbox write for account ${accountId} is already running`,
      );
    }
    this.busy.add(accountId);
  }

  private assertWritesEnabled(): void {
    if (!this.config.mailboxWritesEnabled) {
      throw new ForbiddenException(
        'Mailbox writes are disabled: set MAILBOX_WRITES_ENABLED=true and restart the API',
      );
    }
  }

  private async loadWritableAccount(accountId: string): Promise<EmailAccount> {
    const account = await this.db.emailAccount.findUnique({ where: { id: accountId } });
    if (!account) throw new NotFoundException(`EmailAccount ${accountId} not found`);
    if (!account.isActive) {
      throw new BadRequestException(`EmailAccount ${accountId} is inactive`);
    }
    if (account.needsReauth) {
      throw new BadRequestException(`EmailAccount ${accountId} needs re-authorization`);
    }
    return account;
  }

  private refuseAll(accountId: string, targets: readonly TrashTarget[], reason: string): MoveToTrashResult {
    this.logger.warn(`Account ${accountId}: refusing move to Trash: ${reason}`);
    return {
      accountId,
      trashMailbox: null,
      error: reason,
      results: targets.map((t) => this.result(t, 'failed', null, reason)),
    };
  }

  /** Nothing moved: close the restore row and unlink it so undo can retry. */
  private async markRestoreFailed(id: string, message: string): Promise<void> {
    await this.db.mailboxAction.update({
      where: { id },
      data: { status: MailboxActionStatus.failed, error: message, undoOfId: null },
    });
  }

  private result(
    t: TrashTarget,
    status: TargetOutcome,
    actionId: string | null,
    error: string | null,
    destUid: number | null = null,
  ): TrashTargetResult {
    return { rawEmailId: t.rawEmailId, uid: t.uid, status, actionId, error, destUid };
  }

  private async closeClient(client: ImapFlow): Promise<void> {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}
