import { BadRequestException, Logger } from '@nestjs/common';
import { MailboxAction, Prisma } from '@prisma/client';
import type { ImapFlow, ListResponse } from 'imapflow';
import { DatabaseService } from '../database/database.service';
import { normalizeMessageId, sameMessageId } from './message-id';

/**
 * Read-only IMAP lookups shared by the writer and reconcile. Nothing in
 * this file changes a mailbox: it only lists, fetches, and searches.
 */

export interface EnvelopeInfo {
  messageId: string | null;
  labels: string[];
}

export function uidValidityOf(value: bigint | number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** UIDVALIDITY of the currently selected (locked) mailbox. */
export function selectedUidValidity(client: ImapFlow): string | null {
  return uidValidityOf(client.mailbox ? client.mailbox.uidValidity : null);
}

/** Throws unless every UID is a positive integer and no UID repeats. */
export function assertValidUids(uids: readonly unknown[]): asserts uids is number[] {
  const seen = new Set<number>();
  for (const uid of uids) {
    if (typeof uid !== 'number' || !Number.isInteger(uid) || uid <= 0) {
      throw new BadRequestException(`Invalid IMAP UID: ${String(uid)}`);
    }
    if (seen.has(uid)) {
      throw new BadRequestException(`Duplicate IMAP UID: ${uid}`);
    }
    seen.add(uid);
  }
}

export function isValidUid(uid: unknown): uid is number {
  return typeof uid === 'number' && Number.isInteger(uid) && uid > 0;
}

/**
 * The \Trash folder, only when the server itself advertised it through the
 * SPECIAL-USE extension. A folder merely *named* "Trash" is not trusted.
 * (`specialUseSource` is set by imapflow's LIST at runtime but missing from
 * its type declarations.)
 */
export function findServerTrash(mailboxes: readonly ListResponse[]): ListResponse | null {
  const hits = mailboxes.filter(
    (m) =>
      m.specialUse === '\\Trash' &&
      (m as ListResponse & { specialUseSource?: string }).specialUseSource === 'extension',
  );
  return hits.length === 1 ? hits[0] : null;
}

/** Envelope of one UID in the selected mailbox; null if absent. */
export async function fetchEnvelope(client: ImapFlow, uid: number): Promise<EnvelopeInfo | null> {
  assertValidUids([uid]);
  const msg = await client.fetchOne(uid, { uid: true, envelope: true }, { uid: true });
  if (!msg) return null;
  return { messageId: normalizeMessageId(msg.envelope?.messageId), labels: [] };
}

/** Which of `uids` still exist in the selected mailbox. */
export async function presentUids(client: ImapFlow, uids: number[]): Promise<Set<number>> {
  assertValidUids(uids);
  const present = new Set<number>();
  for await (const msg of client.fetch(uids, { uid: true }, { uid: true })) {
    present.add(msg.uid);
  }
  return present;
}

/**
 * UID in the selected mailbox whose Message-ID equals `messageId` exactly
 * (IMAP HEADER search is a substring match, so every hit is re-verified).
 * Highest UID wins when duplicates exist.
 */
export async function searchByMessageId(client: ImapFlow, messageId: string): Promise<number | null> {
  const hits = await client.search({ header: { 'message-id': messageId } }, { uid: true });
  if (!hits || hits.length === 0) return null;
  for (const uid of [...hits].filter(isValidUid).sort((a, b) => b - a).slice(0, 10)) {
    const env = await fetchEnvelope(client, uid);
    if (env && sameMessageId(messageId, env.messageId)) return uid;
  }
  return null;
}

/**
 * Every UID in the selected mailbox whose Message-ID equals `messageId`
 * exactly (hits re-verified; at most `limit` examined). Used where a
 * duplicate must be detected rather than silently picked.
 */
export async function findAllByMessageId(
  client: ImapFlow,
  messageId: string,
  limit = 10,
): Promise<number[]> {
  const hits = await client.search({ header: { 'message-id': messageId } }, { uid: true });
  if (!hits || hits.length === 0) return [];
  const out: number[] = [];
  for (const uid of [...hits].filter(isValidUid).sort((a, b) => a - b).slice(0, limit)) {
    const env = await fetchEnvelope(client, uid);
    if (env && sameMessageId(messageId, env.messageId)) out.push(uid);
  }
  return out;
}

/** Lock `mailbox` and look a Message-ID up in it. */
export async function findInMailbox(
  client: ImapFlow,
  mailbox: string,
  messageId: string,
): Promise<{ uid: number | null; uidValidity: string | null }> {
  const lock = await client.getMailboxLock(mailbox);
  try {
    return { uid: await searchByMessageId(client, messageId), uidValidity: selectedUidValidity(client) };
  } finally {
    lock.release();
  }
}

/**
 * Point the original RawEmail at the restored UID so the next sync upserts
 * onto it instead of ingesting a duplicate. Skipped when the UID is
 * unknown or another RawEmail already holds it. Database only.
 */
export async function relinkRawEmail(
  db: DatabaseService,
  logger: Logger,
  original: Pick<MailboxAction, 'id' | 'rawEmailId' | 'accountId' | 'sourceMailbox'>,
  restoredUid: number | null,
  restoredUidValidity: string | null,
): Promise<void> {
  if (!original.rawEmailId || restoredUid === null) return;
  try {
    const holder = await db.rawEmail.findUnique({
      where: {
        accountId_mailbox_uid: {
          accountId: original.accountId,
          mailbox: original.sourceMailbox,
          uid: restoredUid,
        },
      },
      select: { id: true },
    });
    if (holder) return;
    await db.rawEmail.update({
      where: { id: original.rawEmailId },
      data: {
        mailbox: original.sourceMailbox,
        uid: restoredUid,
        ...(restoredUidValidity !== null ? { uidValidity: restoredUidValidity } : {}),
      },
    });
  } catch (error) {
    // P2002 (a sync raced us to the UID) or P2025 (RawEmail gone): the
    // restore itself succeeded; the next sync may ingest a duplicate.
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      logger.warn(`RawEmail relink for ${original.id} skipped: ${error.code}`);
      return;
    }
    throw error;
  }
}
