import { ForbiddenException, Logger } from '@nestjs/common';
import type { ImapFlow } from 'imapflow';
import { AppConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import { EmailAccountsService } from '../email-accounts/email-accounts.service';
import { MailboxReconcileService, RECONCILE_MIN_AGE_MS } from './mailbox-reconcile.service';

const TRASH = '[Gmail]/Trash';
const NOW = new Date('2026-09-23T12:00:00Z');
const OLD = new Date(NOW.getTime() - RECONCILE_MIN_AGE_MS - 1000);

/**
 * Read-only fake: ONLY these members exist. Touching anything else
 * (messageMove included) throws and is recorded.
 */
function makeClient(messages: Record<string, Record<number, string>>) {
  const touched: string[] = [];
  let mailbox: false | { path: string; uidValidity: bigint } = false;
  const target = {
    capabilities: new Map([['MOVE', true], ['UIDPLUS', true]]),
    get mailbox() {
      return mailbox;
    },
    connect: jest.fn(async () => undefined),
    list: jest.fn(async () => [
      { path: 'INBOX', specialUse: '\\Inbox', specialUseSource: 'name' },
      { path: TRASH, specialUse: '\\Trash', specialUseSource: 'extension' },
    ]),
    getMailboxLock: jest.fn(async (path: string) => {
      mailbox = { path, uidValidity: BigInt(path === 'INBOX' ? 100 : 200) };
      return { release: jest.fn() };
    }),
    search: jest.fn(async (q: { header: Record<string, string> }): Promise<number[]> => {
      const box = mailbox ? (messages[mailbox.path] ?? {}) : {};
      return Object.entries(box)
        .filter(([, id]) => id.includes(q.header['message-id']))
        .map(([uid]) => Number(uid));
    }),
    fetch: jest.fn(async function* (uids: number[]) {
      const box = mailbox ? (messages[mailbox.path] ?? {}) : {};
      for (const uid of uids) if (box[uid]) yield { uid };
    }),
    fetchOne: jest.fn(async (uid: number): Promise<unknown> => {
      const box = mailbox ? (messages[mailbox.path] ?? {}) : {};
      return box[uid] ? { uid, envelope: { messageId: `<${box[uid]}>` } } : false;
    }),
    logout: jest.fn(async () => undefined),
    close: jest.fn(),
  };
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'string' && !(prop in t)) {
        touched.push(prop);
        throw new Error(`reconcile must not use ImapFlow.${prop}`);
      }
      return Reflect.get(t, prop, receiver);
    },
  });
  return { client: proxy as unknown as ImapFlow, fake: target, touched };
}

type Row = Record<string, unknown> & { id: string; status: string };

function makeFixture(rows: Partial<Row>[], messages: Record<string, Record<number, string>>, writesEnabled = true) {
  const actions = new Map<string, Row>();
  for (const r of rows) {
    const row = {
      action: 'move_to_trash',
      accountId: 'acc1',
      rawEmailId: null,
      undoOfId: null,
      sourceMailbox: 'INBOX',
      sourceUid: 1,
      sourceUidValidity: null,
      destMailbox: TRASH,
      destUid: null,
      destUidValidity: null,
      messageId: null,
      error: null,
      createdAt: OLD,
      ...r,
    } as Row;
    actions.set(row.id, row);
  }
  const rawEmails = new Map<string, Record<string, unknown>>([
    ['raw1', { id: 'raw1', accountId: 'acc1', mailbox: 'INBOX', uid: 1 }],
  ]);
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in (v as object)) return (v as { in: unknown[] }).in.includes(row[k]);
      if (v && typeof v === 'object' && 'lt' in (v as object)) return (row[k] as Date) < (v as { lt: Date }).lt;
      return row[k] === v;
    });
  const db = {
    emailAccount: {
      findUnique: jest.fn(async () => ({ id: 'acc1', isActive: true, needsReauth: false, host: 'h', port: 993, secure: true, username: 'u' })),
    },
    mailboxAction: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...actions.values()].filter((r) => matches(r, where)),
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => actions.get(where.id) ?? null),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of actions.values()) {
          if (matches(r, where)) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      }),
    },
    rawEmail: {
      findUnique: jest.fn(async () => null),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(rawEmails.get(where.id) ?? {}, data),
      ),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const { client, fake, touched } = makeClient(messages);
  const factory = jest.fn(() => client);
  const creds = { getImapCredentials: jest.fn(async () => ({ kind: 'password', password: 'x' })) };
  const service = new MailboxReconcileService(
    db as unknown as DatabaseService,
    { mailboxWritesEnabled: writesEnabled } as unknown as AppConfigService,
    creds as unknown as EmailAccountsService,
    factory as unknown as ConstructorParameters<typeof MailboxReconcileService>[3],
  );
  return { service, db, actions, rawEmails, fake, factory, touched, creds };
}

describe('MailboxReconcileService', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn']));

  it('kill switch off: 403 before any read or IMAP', async () => {
    const f = makeFixture([], {}, false);
    await expect(f.service.reconcile({}, NOW)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.db.mailboxAction.findMany).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
  });

  describe('move_to_trash rows', () => {
    it('uid check: stored UID still in INBOX (same UIDVALIDITY) → failed, even without a Message-ID', async () => {
      const f = makeFixture(
        [{ id: 'a1', status: 'unknown', sourceUid: 7, sourceUidValidity: '100', messageId: null }],
        { INBOX: { 7: 'whatever@x' } },
      );
      const out = await f.service.reconcile({}, NOW);
      expect(out.resolved).toBe(1);
      expect(f.actions.get('a1')).toMatchObject({ status: 'failed' });
      expect(f.fake.search).not.toHaveBeenCalled();
      expect(f.touched).toEqual([]);
    });

    it('uid gone from INBOX, Message-ID once in Trash → succeeded with destUid (undoable)', async () => {
      const f = makeFixture(
        [{ id: 'a1', status: 'unknown', sourceUid: 7, sourceUidValidity: '100', messageId: 'm1@x' }],
        { INBOX: {}, [TRASH]: { 55: 'm1@x' } },
      );
      const out = await f.service.reconcile({}, NOW);
      expect(out).toMatchObject({ examined: 1, resolved: 1, unresolved: 0 });
      expect(f.actions.get('a1')).toMatchObject({ status: 'succeeded', destUid: 55, destUidValidity: '200' });
      expect(f.fake.logout).toHaveBeenCalled();
    });

    it('UID check impossible (UIDVALIDITY changed): Message-ID only in INBOX once → failed', async () => {
      const f = makeFixture(
        [{ id: 'a1', status: 'pending', sourceUid: 7, sourceUidValidity: '1', messageId: 'm1@x' }],
        { INBOX: { 9: 'm1@x' } },
      );
      await f.service.reconcile({}, NOW);
      expect(f.actions.get('a1')).toMatchObject({ status: 'failed' });
    });

    it('Message-ID in BOTH INBOX and Trash → unresolved', async () => {
      const f = makeFixture(
        [{ id: 'a1', status: 'unknown', messageId: 'm1@x' }],
        { INBOX: { 9: 'm1@x' }, [TRASH]: { 55: 'm1@x' } },
      );
      const out = await f.service.reconcile({}, NOW);
      expect(out.unresolved).toBe(1);
      expect(out.accounts[0].items[0].detail).toMatch(/both/);
      expect(f.actions.get('a1')?.status).toBe('unknown');
    });

    it('Message-ID twice in Trash → unresolved', async () => {
      const f = makeFixture([{ id: 'a1', status: 'unknown', messageId: 'm1@x' }], { [TRASH]: { 55: 'm1@x', 56: 'm1@x' } });
      const out = await f.service.reconcile({}, NOW);
      expect(out.unresolved).toBe(1);
      expect(out.accounts[0].items[0].detail).toMatch(/2 times/);
      expect(f.actions.get('a1')?.status).toBe('unknown');
    });

    it('Message-ID twice in INBOX → unresolved', async () => {
      const f = makeFixture([{ id: 'a1', status: 'pending', messageId: 'm1@x' }], { INBOX: { 3: 'm1@x', 4: 'm1@x' } });
      const out = await f.service.reconcile({}, NOW);
      expect(out.unresolved).toBe(1);
      expect(f.actions.get('a1')?.status).toBe('pending');
    });

    it('moved UID gone but a same-Message-ID copy is in INBOX (not Trash) → unresolved', async () => {
      const f = makeFixture(
        [{ id: 'a1', status: 'unknown', sourceUid: 7, sourceUidValidity: '100', messageId: 'm1@x' }],
        { INBOX: { 9: 'm1@x' } },
      );
      const out = await f.service.reconcile({}, NOW);
      expect(out.unresolved).toBe(1);
    });

    it('substring Message-ID search hits that do not match exactly are ignored', async () => {
      const f = makeFixture([{ id: 'a1', status: 'unknown', messageId: 'm1@x' }], { [TRASH]: { 55: 'm1@x', 56: 'xm1@x.y' } });
      await f.service.reconcile({}, NOW);
      expect(f.actions.get('a1')).toMatchObject({ status: 'succeeded', destUid: 55 });
    });
  });

  it('leaves a row it cannot place, or without a Message-ID and no conclusive UID check, unresolved', async () => {
    const f = makeFixture(
      [
        { id: 'a1', status: 'pending', messageId: 'gone@x' },
        { id: 'a2', status: 'unknown', messageId: null },
      ],
      {},
    );
    const out = await f.service.reconcile({}, NOW);
    expect(out).toMatchObject({ examined: 2, resolved: 0, unresolved: 2 });
    expect(f.actions.get('a1')?.status).toBe('pending');
    expect(f.actions.get('a2')?.status).toBe('unknown');
  });

  it('ignores rows younger than the in-flight window', async () => {
    const f = makeFixture([{ id: 'a1', status: 'pending', messageId: 'm1@x', createdAt: NOW }], { [TRASH]: { 5: 'm1@x' } });
    const out = await f.service.reconcile({}, NOW);
    expect(out.examined).toBe(0);
    expect(f.factory).not.toHaveBeenCalled();
  });

  describe('restore rows', () => {
    const restoreRows = (over: Partial<Row> = {}): Partial<Row>[] => [
      { id: 'orig', status: 'pending', messageId: 'm1@x', rawEmailId: 'raw1', destUid: 900 },
      {
        id: 'rest',
        action: 'restore',
        status: 'unknown',
        undoOfId: 'orig',
        sourceMailbox: TRASH,
        sourceUid: 55,
        sourceUidValidity: '200',
        destMailbox: 'INBOX',
        messageId: 'm1@x',
        ...over,
      },
    ];

    it('uid check: Trash UID still there (same UIDVALIDITY) → restore failed + unlinked, original succeeded', async () => {
      const f = makeFixture(restoreRows({ messageId: null }), { [TRASH]: { 55: 'm1@x' } });
      await f.service.reconcile({}, NOW);
      expect(f.actions.get('rest')).toMatchObject({ status: 'failed', undoOfId: null });
      expect(f.actions.get('orig')).toMatchObject({ status: 'succeeded', destUid: 55, destMailbox: TRASH });
      expect(f.touched).toEqual([]);
    });

    it('Trash UID gone, Message-ID once in INBOX → restore succeeded, original undone, RawEmail relinked', async () => {
      const f = makeFixture(restoreRows(), { [TRASH]: {}, INBOX: { 77: 'm1@x' } });
      const out = await f.service.reconcile({}, NOW);
      // The claimed original is resolved through its restore row.
      expect(out.examined).toBe(1);
      expect(f.actions.get('rest')).toMatchObject({ status: 'succeeded', destUid: 77 });
      expect(f.actions.get('orig')).toMatchObject({ status: 'undone' });
      expect(f.rawEmails.get('raw1')).toMatchObject({ uid: 77, uidValidity: '100' });
    });

    it('Message-ID in BOTH INBOX and Trash (UID check impossible) → unresolved', async () => {
      const f = makeFixture(restoreRows({ sourceUidValidity: '1' }), { [TRASH]: { 60: 'm1@x' }, INBOX: { 77: 'm1@x' } });
      const out = await f.service.reconcile({}, NOW);
      expect(out.unresolved).toBe(1);
      expect(f.actions.get('rest')?.status).toBe('unknown');
      expect(f.actions.get('orig')?.status).toBe('pending');
    });

    it('Message-ID twice in INBOX → unresolved', async () => {
      const f = makeFixture(restoreRows(), { [TRASH]: {}, INBOX: { 77: 'm1@x', 78: 'm1@x' } });
      const out = await f.service.reconcile({}, NOW);
      expect(out.unresolved).toBe(1);
      expect(f.actions.get('orig')?.status).toBe('pending');
    });

    it('UID check impossible, Message-ID once in Trash → restore failed, original back to succeeded', async () => {
      const f = makeFixture(restoreRows({ sourceUidValidity: null }), { [TRASH]: { 61: 'm1@x' } });
      await f.service.reconcile({}, NOW);
      expect(f.actions.get('rest')).toMatchObject({ status: 'failed', undoOfId: null });
      expect(f.actions.get('orig')).toMatchObject({ status: 'succeeded', destUid: 61 });
    });
  });

  it('isolates an account it cannot use', async () => {
    const f = makeFixture([{ id: 'a1', status: 'pending', messageId: 'm1@x' }], {});
    f.db.emailAccount.findUnique.mockResolvedValueOnce({ id: 'acc1', isActive: true, needsReauth: true } as never);
    const out = await f.service.reconcile({}, NOW);
    expect(out.accounts[0].error).toMatch(/re-authorization/);
    expect(f.factory).not.toHaveBeenCalled();
  });
});
