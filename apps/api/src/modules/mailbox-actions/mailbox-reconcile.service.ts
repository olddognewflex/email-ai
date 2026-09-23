import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  EmailAccount,
  MailboxAction,
  MailboxActionStatus,
  MailboxActionType,
} from '@prisma/client';
import type { ImapFlow } from 'imapflow';
import {
  MailboxReconcileItem,
  MailboxReconcileQuery,
  MailboxReconcileResponse,
} from '@email-ai/shared';
import { AppConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import { EmailAccountsService } from '../email-accounts/email-accounts.service';
import {
  IMAP_CLIENT_FACTORY,
  ImapClientFactory,
} from '../email-sync/imap-client.factory';
import {
  findAllByMessageId,
  findServerTrash,
  isValidUid,
  presentUids,
  relinkRawEmail,
  selectedUidValidity,
} from './imap-lookup';
import { normalizeMessageId } from './message-id';

/** Rows younger than this may still be in flight in a running write. */
export const RECONCILE_MIN_AGE_MS = 10 * 60 * 1000;

const SOURCE_MAILBOX = 'INBOX';

interface Probe {
  mailbox: string;
  uidValidity: string | null;
  /** Stored UID still present; null when the UID check is impossible. */
  uidPresent: boolean | null;
  /** Verified UIDs with the stored Message-ID; null when none is known. */
  midHits: number[] | null;
}

type ItemFn = (to: MailboxActionStatus | null, detail: string) => MailboxReconcileItem;

/**
 * Resolves MailboxAction rows left `pending` or `unknown` (a crash, a lost
 * IMAP response, a failed audit write). The exact stored UID is checked
 * first (definitive while the folder's UIDVALIDITY is unchanged); the
 * stored Message-ID is only a fallback, and a Message-ID found in both
 * folders, or more than once in one, leaves the row unresolved.
 *
 * READ-ONLY ON IMAP: it lists, locks, searches and fetches envelopes. It
 * never moves, flags, or deletes anything, and it does not depend on the
 * write service at all. Database updates only change audit rows (and, for
 * a restore found in INBOX, re-point the RawEmail like undo does).
 */
@Injectable()
export class MailboxReconcileService {
  private readonly logger = new Logger(MailboxReconcileService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly emailAccounts: EmailAccountsService,
    @Inject(IMAP_CLIENT_FACTORY)
    private readonly createClient: ImapClientFactory,
  ) {}

  async reconcile(query: MailboxReconcileQuery, now = new Date()): Promise<MailboxReconcileResponse> {
    if (!this.config.mailboxWritesEnabled) {
      throw new ForbiddenException(
        'Mailbox writes are disabled: set MAILBOX_WRITES_ENABLED=true and restart the API',
      );
    }

    const stuck = await this.db.mailboxAction.findMany({
      where: {
        status: { in: [MailboxActionStatus.pending, MailboxActionStatus.unknown] },
        createdAt: { lt: new Date(now.getTime() - RECONCILE_MIN_AGE_MS) },
        ...(query.accountId ? { accountId: query.accountId } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const byAccount = new Map<string, MailboxAction[]>();
    for (const row of stuck) {
      const list = byAccount.get(row.accountId) ?? [];
      list.push(row);
      byAccount.set(row.accountId, list);
    }

    const accounts: MailboxReconcileResponse['accounts'] = [];
    for (const [accountId, rows] of byAccount) {
      try {
        accounts.push({ accountId, error: null, items: await this.reconcileAccount(accountId, rows) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Reconcile of account ${accountId} failed: ${message}`);
        accounts.push({
          accountId,
          error: message,
          items: rows.map((r) => ({ id: r.id, action: r.action, from: r.status, to: null, detail: 'account not reconciled' })),
        });
      }
    }

    const items = accounts.flatMap((a) => a.items);
    return {
      examined: items.length,
      resolved: items.filter((i) => i.to !== null).length,
      unresolved: items.filter((i) => i.to === null).length,
      accounts,
    };
  }

  private async reconcileAccount(accountId: string, rows: MailboxAction[]): Promise<MailboxReconcileItem[]> {
    const account = await this.db.emailAccount.findUnique({ where: { id: accountId } });
    if (!account || !account.isActive || account.needsReauth) {
      throw new Error(`EmailAccount ${accountId} is missing, inactive, or needs re-authorization`);
    }

    // Originals claimed by a still-open restore are resolved through it.
    const restoreRows = rows.filter((r) => r.action === MailboxActionType.restore);
    const claimed = new Set(restoreRows.map((r) => r.undoOfId).filter((id): id is string => !!id));
    const moveRows = rows.filter((r) => r.action === MailboxActionType.move_to_trash && !claimed.has(r.id));

    const credentials = await this.emailAccounts.getImapCredentials(accountId);
    const client = this.createClient(account as EmailAccount, credentials);
    const items: MailboxReconcileItem[] = [];
    try {
      await client.connect();
      const trash = findServerTrash(await client.list());
      for (const row of moveRows) {
        items.push(await this.reconcileMove(client, row, trash?.path ?? null));
      }
      for (const row of restoreRows) {
        items.push(await this.reconcileRestore(client, row));
      }
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
    return items;
  }

  /**
   * Look at one folder for one row: whether the exact stored UID is still
   * there (only when the folder's current UIDVALIDITY equals the stored
   * one, else null = UID check impossible), and every UID carrying the
   * stored Message-ID (null when no Message-ID is known).
   */
  private async probe(
    client: ImapFlow,
    mailbox: string,
    uid: number | null,
    uidValidity: string | null,
    messageId: string | null,
  ): Promise<Probe> {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const current = selectedUidValidity(client);
      const uidPresent =
        isValidUid(uid) && uidValidity !== null && current !== null && uidValidity === current
          ? (await presentUids(client, [uid])).has(uid)
          : null;
      const midHits = messageId ? await findAllByMessageId(client, messageId) : null;
      return { mailbox, uidValidity: current, uidPresent, midHits };
    } finally {
      lock.release();
    }
  }

  /**
   * move_to_trash row. Definitive UID check first: the stored source UID
   * still in INBOX (same UIDVALIDITY) means it was not moved. Message-ID
   * is only a fallback, and any ambiguity (found in both folders, or more
   * than once in one) leaves the row unresolved.
   */
  private async reconcileMove(
    client: ImapFlow,
    row: MailboxAction,
    serverTrash: string | null,
  ): Promise<MailboxReconcileItem> {
    const item = this.itemFor(row);
    const mid = normalizeMessageId(row.messageId);

    const inbox = await this.probe(client, SOURCE_MAILBOX, row.sourceUid, row.sourceUidValidity, mid);
    if (inbox.uidPresent === true) {
      return this.done(
        item,
        await this.transition(row, {
          status: MailboxActionStatus.failed,
          error: appendNote(row.error, `reconciled: not moved, uid ${row.sourceUid} still in INBOX`),
        }),
        MailboxActionStatus.failed,
        `uid ${row.sourceUid} still in INBOX: not moved`,
      );
    }

    const trashPath = row.destMailbox ?? serverTrash;
    if (!trashPath) return item(null, 'no Trash folder known');
    const trash = await this.probe(client, trashPath, row.destUid, row.destUidValidity, mid);
    if (trash.uidPresent === true) {
      return this.promoteMove(row, item, trashPath, row.destUid as number, trash.uidValidity, 'uid check');
    }

    if (!mid) {
      return item(null, 'no Message-ID recorded and the UID check was not conclusive; check by hand');
    }
    const inI = inbox.midHits ?? [];
    const inT = trash.midHits ?? [];
    if (inI.length > 0 && inT.length > 0) return item(null, `Message-ID found in both INBOX and ${trashPath}; check by hand`);
    if (inT.length > 1) return item(null, `Message-ID found ${inT.length} times in ${trashPath}; check by hand`);
    if (inT.length === 1) return this.promoteMove(row, item, trashPath, inT[0], trash.uidValidity, 'Message-ID');
    if (inI.length > 1) return item(null, `Message-ID found ${inI.length} times in INBOX; check by hand`);
    if (inI.length === 1) {
      if (inbox.uidPresent === false) {
        return item(null, 'the moved UID left INBOX but another copy with the same Message-ID is there; check by hand');
      }
      return this.done(
        item,
        await this.transition(row, {
          status: MailboxActionStatus.failed,
          error: appendNote(row.error, 'reconciled: not moved, still in INBOX (Message-ID)'),
        }),
        MailboxActionStatus.failed,
        'still in INBOX (Message-ID): not moved',
      );
    }
    return item(null, `not found in INBOX or ${trashPath}; check the mailbox by hand`);
  }

  private async promoteMove(
    row: MailboxAction,
    item: ItemFn,
    trashPath: string,
    uid: number,
    uidValidity: string | null,
    how: string,
  ): Promise<MailboxReconcileItem> {
    return this.done(
      item,
      await this.transition(row, {
        status: MailboxActionStatus.succeeded,
        destMailbox: trashPath,
        destUid: uid,
        destUidValidity: uidValidity,
        error: appendNote(row.error, `reconciled: found in ${trashPath} (${how})`),
      }),
      MailboxActionStatus.succeeded,
      `found in ${trashPath} (uid ${uid}, ${how})`,
    );
  }

  /**
   * restore row (and the `pending` original it links to). Definitive UID
   * check first: the stored Trash UID still in Trash (same UIDVALIDITY)
   * means the restore did not happen.
   */
  private async reconcileRestore(client: ImapFlow, row: MailboxAction): Promise<MailboxReconcileItem> {
    const item = this.itemFor(row);
    const mid = normalizeMessageId(row.messageId);
    const original = row.undoOfId
      ? await this.db.mailboxAction.findUnique({ where: { id: row.undoOfId } })
      : null;
    const inboxPath = row.destMailbox ?? SOURCE_MAILBOX;

    const trash = await this.probe(client, row.sourceMailbox, row.sourceUid, row.sourceUidValidity, mid);
    if (trash.uidPresent === true) {
      return this.restoreNotMoved(row, original, item, row.sourceUid, trash.uidValidity, 'uid check');
    }
    const inbox = await this.probe(client, inboxPath, row.destUid, row.destUidValidity, mid);
    if (inbox.uidPresent === true) {
      return this.restoreMoved(row, original, item, row.destUid as number, inbox.uidValidity, 'uid check');
    }

    if (!mid) {
      return item(null, 'no Message-ID recorded and the UID check was not conclusive; check by hand');
    }
    const inI = inbox.midHits ?? [];
    const inT = trash.midHits ?? [];
    if (inI.length > 0 && inT.length > 0) return item(null, `Message-ID found in both ${inboxPath} and ${row.sourceMailbox}; check by hand`);
    if (inI.length > 1) return item(null, `Message-ID found ${inI.length} times in ${inboxPath}; check by hand`);
    if (inI.length === 1) return this.restoreMoved(row, original, item, inI[0], inbox.uidValidity, 'Message-ID');
    if (inT.length > 1) return item(null, `Message-ID found ${inT.length} times in ${row.sourceMailbox}; check by hand`);
    if (inT.length === 1) {
      if (trash.uidPresent === false) {
        return item(null, `the Trash UID is gone but another copy with the same Message-ID is in ${row.sourceMailbox}; check by hand`);
      }
      return this.restoreNotMoved(row, original, item, inT[0], trash.uidValidity, 'Message-ID');
    }
    return item(null, `not found in ${inboxPath} or ${row.sourceMailbox}; check the mailbox by hand`);
  }

  /** The restore happened: restore succeeded, original undone, RawEmail relinked. */
  private async restoreMoved(
    row: MailboxAction,
    original: MailboxAction | null,
    item: ItemFn,
    uid: number,
    uidValidity: string | null,
    how: string,
  ): Promise<MailboxReconcileItem> {
    const ops = [
      this.db.mailboxAction.updateMany({
        where: { id: row.id, status: row.status },
        data: {
          status: MailboxActionStatus.succeeded,
          destUid: uid,
          destUidValidity: uidValidity,
          error: appendNote(row.error, `reconciled: found in INBOX (${how})`),
        },
      }),
      ...(original && original.status === MailboxActionStatus.pending
        ? [
            this.db.mailboxAction.updateMany({
              where: { id: original.id, status: MailboxActionStatus.pending },
              data: { status: MailboxActionStatus.undone, undoneAt: new Date() },
            }),
          ]
        : []),
    ];
    const [first] = await this.db.$transaction(ops);
    if (first.count === 0) return item(null, 'row changed concurrently');
    if (original) {
      await relinkRawEmail(this.db, this.logger, original, uid, uidValidity).catch((e) =>
        this.logger.error(`RawEmail relink during reconcile failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    return item(MailboxActionStatus.succeeded, `found in INBOX (uid ${uid}, ${how}); original undone`);
  }

  /** Nothing moved: close the restore and hand the original back. */
  private async restoreNotMoved(
    row: MailboxAction,
    original: MailboxAction | null,
    item: ItemFn,
    uid: number,
    uidValidity: string | null,
    how: string,
  ): Promise<MailboxReconcileItem> {
    const ops = [
      this.db.mailboxAction.updateMany({
        where: { id: row.id, status: row.status },
        data: {
          status: MailboxActionStatus.failed,
          undoOfId: null,
          error: appendNote(row.error, `reconciled: not moved, still in ${row.sourceMailbox} (${how})`),
        },
      }),
      ...(original && original.status === MailboxActionStatus.pending
        ? [
            this.db.mailboxAction.updateMany({
              where: { id: original.id, status: MailboxActionStatus.pending },
              data: {
                status: MailboxActionStatus.succeeded,
                destMailbox: row.sourceMailbox,
                destUid: uid,
                destUidValidity: uidValidity,
              },
            }),
          ]
        : []),
    ];
    const [first] = await this.db.$transaction(ops);
    if (first.count === 0) return item(null, 'row changed concurrently');
    return item(
      MailboxActionStatus.failed,
      `still in ${row.sourceMailbox} (uid ${uid}, ${how}): not restored; original can be undone again`,
    );
  }

  private itemFor(row: MailboxAction): ItemFn {
    return (to, detail) => ({ id: row.id, action: row.action, from: row.status, to, detail });
  }

  private done(item: ItemFn, ok: boolean, to: MailboxActionStatus, detail: string): MailboxReconcileItem {
    return ok ? item(to, detail) : item(null, 'row changed concurrently');
  }

  /** Conditional update: only if the row still has the status we read. */
  private async transition(row: MailboxAction, data: Record<string, unknown>): Promise<boolean> {
    const res = await this.db.mailboxAction.updateMany({
      where: { id: row.id, status: row.status },
      data,
    });
    return res.count === 1;
  }
}

function appendNote(existing: string | null, note: string): string {
  return existing ? `${existing}; ${note}` : note;
}
