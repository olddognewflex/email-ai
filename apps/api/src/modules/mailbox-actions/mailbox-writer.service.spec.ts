import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ImapFlow } from 'imapflow';
import { AppConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import { EmailAccountsService } from '../email-accounts/email-accounts.service';
import { Prisma } from '@prisma/client';
import {
  MOVE_CHUNK_SIZE,
  SKIP_IN_PROGRESS,
  SKIP_PREVIOUSLY_TRASHED,
  MailboxWriterService,
  REFUSE_NO_MOVE,
  REFUSE_NO_TRASH,
  SKIP_IDENTITY_UNVERIFIED,
  SKIP_MESSAGE_ID_MISMATCH,
  SKIP_NOT_FOUND,
  SKIP_UIDVALIDITY_CHANGED,
  TrashTarget,
  findServerTrash,
} from './mailbox-writer.service';

/*
 * Strict fake ImapFlow. Destructive members (names assembled at runtime so
 * the static guard spec keeps passing) throw when called, and reading any
 * member the fake does not define throws too, so a new IMAP call in the
 * writer fails these tests until it is deliberately allowed here.
 */
const FORBIDDEN = [
  'message' + 'Delete',
  'message' + 'FlagsAdd',
  'message' + 'FlagsSet',
  'message' + 'FlagsRemove',
  'exp' + 'unge',
  'message' + 'Copy',
  'append',
  'mailbox' + 'Delete',
  'mailboxCreate',
  'mailbox' + 'Rename',
  'setFlagColor',
];

const TRASH = '[Gmail]/Trash';
const INBOX_UIDVALIDITY = '4294967295';
const TRASH_UIDVALIDITY = '555';

interface FakeMessage {
  messageId: string | null;
  labels?: string[];
}

interface FakeOptions {
  capabilities?: string[];
  list?: object[];
  uidValidity?: Record<string, string | null>;
  /** Messages per mailbox, keyed by UID. */
  messages?: Record<string, Record<number, FakeMessage>>;
  /** Custom MOVE result; call `relocate()` to actually move the messages. */
  messageMove?: (uids: number[], dest: string, relocate: () => void) => unknown;
  connectError?: Error;
  fetchError?: Error;
  /** Throw from the post-MOVE presence re-check (a fetch without envelope). */
  recheckError?: Error;
}

function makeFakeClient(log: string[], opts: FakeOptions = {}) {
  const forbiddenCalls: string[] = [];
  const messages = opts.messages ?? {};
  const uidValidity = opts.uidValidity ?? {
    INBOX: INBOX_UIDVALIDITY,
    [TRASH]: TRASH_UIDVALIDITY,
  };
  let mailbox: false | { path: string; uidValidity?: bigint } = false;
  const currentBox = (): Record<number, FakeMessage> =>
    (mailbox ? messages[mailbox.path] : undefined) ?? {};
  const target = {
    capabilities: new Map<string, boolean>(
      (opts.capabilities ?? ['IMAP4rev1', 'MOVE', 'UIDPLUS']).map((c) => [c, true]),
    ),
    get mailbox() {
      return mailbox;
    },
    connect: jest.fn(async () => {
      log.push('connect');
      if (opts.connectError) throw opts.connectError;
    }),
    list: jest.fn(async () =>
      opts.list ?? [
        { path: 'INBOX', specialUse: '\\Inbox', specialUseSource: 'name' },
        { path: TRASH, specialUse: '\\Trash', specialUseSource: 'extension' },
      ],
    ),
    getMailboxLock: jest.fn(async (path: string) => {
      log.push(`lock:${path}`);
      const v = uidValidity[path];
      mailbox = { path, ...(v ? { uidValidity: BigInt(v) } : {}) };
      return { path, release: jest.fn(() => log.push(`release:${path}`)) };
    }),
    fetch: jest.fn(async function* (uids: number[], query: { labels?: boolean; envelope?: boolean }) {
      log.push(`fetch:${uids.join(',')}`);
      if (opts.fetchError) throw opts.fetchError;
      if (opts.recheckError && !('envelope' in query)) throw opts.recheckError;
      const box = currentBox();
      for (const uid of uids) {
        const m = box[uid];
        if (!m) continue;
        yield {
          uid,
          envelope: { messageId: m.messageId ?? undefined },
          ...(query.labels ? { labels: new Set(m.labels ?? []) } : {}),
        };
      }
    }),
    fetchOne: jest.fn(async (seq: number): Promise<unknown> => {
      expect(typeof seq).toBe('number');
      const m = currentBox()[Number(seq)];
      return m ? { uid: Number(seq), envelope: { messageId: m.messageId ?? undefined } } : false;
    }),
    search: jest.fn(async (q: { header: Record<string, string> }): Promise<number[]> => {
      const want = q.header['message-id'];
      return Object.entries(currentBox())
        .filter(([, m]) => m.messageId?.includes(want))
        .map(([uid]) => Number(uid));
    }),
    messageMove: jest.fn(async (uids: number[], dest: string, options: { uid?: boolean }): Promise<unknown> => {
      log.push(`messageMove:${uids.join(',')}->${dest}`);
      expect(Array.isArray(uids)).toBe(true);
      expect(options).toEqual({ uid: true });
      const from = mailbox ? mailbox.path : '';
      const relocate = () => {
        const src = (messages[from] ??= {});
        const dst = (messages[dest] ??= {});
        for (const u of uids) {
          if (src[u]) {
            dst[u + 1000] = src[u];
            delete src[u];
          }
        }
      };
      if (opts.messageMove) return opts.messageMove(uids, dest, relocate);
      relocate();
      return {
        path: mailbox ? mailbox.path : '',
        destination: dest,
        uidValidity: BigInt(dest === 'INBOX' ? INBOX_UIDVALIDITY : TRASH_UIDVALIDITY),
        uidMap: new Map(uids.map((u) => [u, u + 1000])),
      };
    }),
    logout: jest.fn(async () => log.push('logout')),
    close: jest.fn(() => log.push('close')),
  };
  const forbidden = new Set(FORBIDDEN);
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'string') {
        if (forbidden.has(prop)) {
          return () => {
            forbiddenCalls.push(prop);
            throw new Error(`forbidden IMAP call: ${prop}`);
          };
        }
        if (!(prop in t)) {
          forbiddenCalls.push(prop);
          throw new Error(`unexpected ImapFlow member: ${prop}`);
        }
      }
      return Reflect.get(t, prop, receiver);
    },
  });
  return { client: proxy as unknown as ImapFlow, fake: target, forbiddenCalls };
}

type Row = Record<string, unknown> & { id: string; status: string };

/** Minimal Prisma `where`: equality, `{in}`, `{lt}` and `OR`. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => matches(row, w));
    if (v && typeof v === 'object' && 'in' in (v as object)) {
      return ((v as { in: unknown[] }).in).includes(row[k]);
    }
    if (v && typeof v === 'object' && 'lt' in (v as object)) {
      return (row[k] as Date) < (v as { lt: Date }).lt;
    }
    return row[k] === v;
  });
}

const ACTIVE = ['pending', 'succeeded', 'unknown'];

/** The migration's partial unique indexes: one active move per message. */
function violatesOneActiveMove(rows: Iterable<Row>, data: Record<string, unknown>): boolean {
  if (data.action !== 'move_to_trash' || !ACTIVE.includes(String(data.status))) return false;
  for (const r of rows) {
    if (r.action !== 'move_to_trash' || !ACTIVE.includes(r.status)) continue;
    if (
      r.accountId === data.accountId &&
      data.sourceUidValidity != null &&
      r.sourceUidValidity === data.sourceUidValidity &&
      r.sourceUid === data.sourceUid
    ) {
      return true;
    }
    if (data.rawEmailId != null && r.rawEmailId === data.rawEmailId) return true;
  }
  return false;
}

function lazy<T>(run: () => Promise<T>): PromiseLike<T> {
  let p: Promise<T> | undefined;
  return {
    then(onFulfilled, onRejected) {
      p ??= run();
      return p.then(onFulfilled, onRejected);
    },
  };
}

function makeDb(log: string[], account: Record<string, unknown> = {}) {
  const actions = new Map<string, Row>();
  let seq = 0;
  const insert = (data: Record<string, unknown>): Row => {
    const row = {
      id: `act${++seq}`,
      rawEmailId: null,
      senderRuleId: null,
      undoOfId: null,
      sourceUidValidity: null,
      destMailbox: null,
      destUid: null,
      destUidValidity: null,
      messageId: null,
      fromAddress: null,
      subject: null,
      gmailLabels: [],
      error: null,
      undoneAt: null,
      createdAt: new Date(),
      ...data,
    } as unknown as Row;
    actions.set(row.id, row);
    return row;
  };
  const rawEmails = new Map<string, Record<string, unknown>>();

  const db = {
    emailAccount: {
      findUnique: jest.fn(async () => ({
        id: 'acc1',
        label: 'Gmail',
        host: 'imap.example.com',
        port: 993,
        secure: true,
        username: 'me@example.com',
        isActive: true,
        needsReauth: false,
        ...account,
      })),
    },
    mailboxAction: {
      createManyAndReturn: jest.fn(
        async ({ data }: { data: Record<string, unknown>[] }) => {
          log.push(`db:create:${data.map((d) => d.status).join(',')}`);
          return data.map((d) => {
            const row = insert(d);
            return { id: row.id, sourceUid: row.sourceUid };
          });
        },
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        log.push(`db:create:${data.action}:${data.status}`);
        if (violatesOneActiveMove(actions.values(), data)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 't',
          });
        }
        return insert(data);
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const r = actions.get(where.id);
        return r ? { ...r } : null;
      }),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...actions.values()].filter((r) => matches(r, where)).map((r) => ({ ...r })),
      ),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        lazy(async () => {
          const r = actions.get(where.id);
          if (!r) throw new Error(`no row ${where.id}`);
          Object.assign(r, data);
          log.push(`db:update:${where.id}:${String(data.status ?? '')}`);
          return { ...r };
        }),
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          let count = 0;
          for (const r of actions.values()) {
            if (matches(r, where)) {
              Object.assign(r, data);
              count++;
            }
          }
          log.push(`db:updateMany:${count}:${String(data.status ?? '')}`);
          return { count };
        },
      ),
    },
    rawEmail: {
      findUnique: jest.fn(
        async ({ where }: { where: { accountId_mailbox_uid: { uid: number; mailbox: string } } }) => {
          const k = where.accountId_mailbox_uid;
          for (const r of rawEmails.values()) {
            if (r.uid === k.uid && r.mailbox === k.mailbox) return { id: r.id };
          }
          return null;
        },
      ),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const r = rawEmails.get(where.id);
          if (!r) throw new Error('no raw email');
          Object.assign(r, data);
          return r;
        },
      ),
    },
    $transaction: jest.fn(async (ops: PromiseLike<unknown>[]) => Promise.all(ops)),
  };
  return { db, actions, rawEmails, insert };
}

function makeService(opts: {
  writesEnabled?: boolean;
  account?: Record<string, unknown>;
  imap?: FakeOptions;
} = {}) {
  const log: string[] = [];
  const { db, actions, rawEmails, insert } = makeDb(log, opts.account);
  const { client, fake, forbiddenCalls } = makeFakeClient(log, opts.imap);
  const factory = jest.fn(() => client);
  const accounts = {
    getImapCredentials: jest.fn(async () => ({ kind: 'password', password: 'x' })),
  };
  const config = { mailboxWritesEnabled: opts.writesEnabled ?? true };
  const service = new MailboxWriterService(
    db as unknown as DatabaseService,
    config as unknown as AppConfigService,
    accounts as unknown as EmailAccountsService,
    factory as unknown as ConstructorParameters<typeof MailboxWriterService>[3],
  );
  return { service, db, actions, rawEmails, insert, fake, factory, accounts, log, forbiddenCalls };
}

const target = (uid: number, over: Partial<TrashTarget> = {}): TrashTarget => ({
  rawEmailId: `raw${uid}`,
  uid,
  uidValidity: INBOX_UIDVALIDITY,
  messageId: `m${uid}@example.com`,
  fromAddress: 'promo@spam.example',
  subject: `Deal ${uid}`,
  ...over,
});

const inbox = (...uids: number[]): Record<number, FakeMessage> =>
  Object.fromEntries(uids.map((u) => [u, { messageId: `<m${u}@example.com>` }]));

const ctx = { senderRuleId: 'rule1' };

describe('MailboxWriterService.moveToTrash', () => {
  let forbiddenCalls: string[] = [];
  afterEach(() => {
    // No test may ever reach a destructive IMAP member.
    expect(forbiddenCalls).toEqual([]);
  });

  it('kill switch off: refuses before reading the account, credentials, or building a client', async () => {
    const s = makeService({ writesEnabled: false });
    forbiddenCalls = s.forbiddenCalls;
    await expect(s.service.moveToTrash('acc1', [target(1)], ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(s.db.emailAccount.findUnique).not.toHaveBeenCalled();
    expect(s.accounts.getImapCredentials).not.toHaveBeenCalled();
    expect(s.factory).not.toHaveBeenCalled();
    expect(s.db.mailboxAction.createManyAndReturn).not.toHaveBeenCalled();
  });

  it.each([
    [{ needsReauth: true }],
    [{ isActive: false }],
  ])('refuses an unusable account %p without connecting', async (account) => {
    const s = makeService({ account });
    forbiddenCalls = s.forbiddenCalls;
    await expect(s.service.moveToTrash('acc1', [target(1)], ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(s.accounts.getImapCredentials).not.toHaveBeenCalled();
    expect(s.factory).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, '7'])('rejects UID %p before connecting', async (uid) => {
    const s = makeService();
    forbiddenCalls = s.forbiddenCalls;
    await expect(
      s.service.moveToTrash('acc1', [target(1), { ...target(2), uid: uid as number }], ctx),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(s.factory).not.toHaveBeenCalled();
  });

  it('rejects duplicate UIDs before connecting', async () => {
    const s = makeService();
    forbiddenCalls = s.forbiddenCalls;
    await expect(s.service.moveToTrash('acc1', [target(3), target(3)], ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(s.factory).not.toHaveBeenCalled();
  });

  it('refuses a server without MOVE: nothing moved, no rows, logout called', async () => {
    const s = makeService({ imap: { capabilities: ['IMAP4rev1', 'UIDPLUS'], messages: { INBOX: inbox(1) } } });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1)], ctx);
    expect(out.error).toBe(REFUSE_NO_MOVE);
    expect(out.results).toEqual([expect.objectContaining({ uid: 1, status: 'failed', error: REFUSE_NO_MOVE })]);
    expect(s.fake.messageMove).not.toHaveBeenCalled();
    expect(s.fake.getMailboxLock).not.toHaveBeenCalled();
    expect(s.db.mailboxAction.createManyAndReturn).not.toHaveBeenCalled();
    expect(s.fake.logout).toHaveBeenCalled();
  });

  it.each(['name', 'user', undefined])(
    'refuses a \\Trash folder whose special-use came from %p, not the server',
    async (source) => {
      const s = makeService({
        imap: {
          list: [{ path: 'Trash', specialUse: '\\Trash', specialUseSource: source }],
          messages: { INBOX: inbox(1) },
        },
      });
      forbiddenCalls = s.forbiddenCalls;
      const out = await s.service.moveToTrash('acc1', [target(1)], ctx);
      expect(out.error).toBe(REFUSE_NO_TRASH);
      expect(s.fake.messageMove).not.toHaveBeenCalled();
      expect(s.fake.logout).toHaveBeenCalled();
    },
  );

  it('happy path: write-ahead pending rows, UID MOVE with number[], destUid from uidMap', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(10, 11) } } });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(10), target(11)], ctx);

    expect(out.trashMailbox).toBe(TRASH);
    expect(out.results.map((r) => [r.uid, r.status, r.destUid])).toEqual([
      [10, 'succeeded', 1010],
      [11, 'succeeded', 1011],
    ]);
    expect(s.fake.messageMove).toHaveBeenCalledWith([10, 11], TRASH, { uid: true });

    // Pending rows are written before the MOVE is sent.
    const creates = s.log.flatMap((l, i) => (l === 'db:create:move_to_trash:pending' ? [i] : []));
    const moveIdx = s.log.findIndex((l) => l.startsWith('messageMove:'));
    expect(creates).toHaveLength(2);
    expect(Math.max(...creates)).toBeLessThan(moveIdx);

    const rows = [...s.actions.values()];
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({
        action: 'move_to_trash',
        status: 'succeeded',
        accountId: 'acc1',
        senderRuleId: 'rule1',
        sourceMailbox: 'INBOX',
        sourceUidValidity: INBOX_UIDVALIDITY,
        destMailbox: TRASH,
        destUidValidity: TRASH_UIDVALIDITY,
      });
    }
    expect(rows.map((r) => r.destUid)).toEqual([1010, 1011]);
    expect(rows.map((r) => r.messageId)).toEqual(['m10@example.com', 'm11@example.com']);
    // Lock released, then logout.
    expect(s.log.slice(-2)).toEqual(['release:INBOX', 'logout']);
  });

  it('records Gmail labels when the server has X-GM-EXT-1', async () => {
    const s = makeService({
      imap: {
        capabilities: ['MOVE', 'UIDPLUS', 'X-GM-EXT-1'],
        messages: { INBOX: { 5: { messageId: '<m5@example.com>', labels: ['\\Inbox', 'Promos'] } } },
      },
    });
    forbiddenCalls = s.forbiddenCalls;
    await s.service.moveToTrash('acc1', [target(5)], ctx);
    expect([...s.actions.values()][0].gmailLabels).toEqual(['Promos', '\\Inbox']);
  });

  it('per-target senderRuleId overrides ctx', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(5) } } });
    forbiddenCalls = s.forbiddenCalls;
    await s.service.moveToTrash('acc1', [target(5, { senderRuleId: 'rule9' })], ctx);
    expect([...s.actions.values()][0].senderRuleId).toBe('rule9');
  });

  it('succeeds with destUid null when the server reports no COPYUID (no UIDPLUS)', async () => {
    const s = makeService({
      imap: {
        capabilities: ['MOVE'],
        messages: { INBOX: inbox(4) },
        messageMove: (_u, dest, relocate) => {
          relocate();
          return { path: 'INBOX', destination: dest };
        },
      },
    });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(4)], ctx);
    expect(out.results[0]).toMatchObject({ status: 'succeeded', destUid: null });
    expect([...s.actions.values()][0]).toMatchObject({ status: 'succeeded', destUid: null, destUidValidity: null });
  });

  it('marks a UID missing from COPYUID as failed', async () => {
    const s = makeService({
      imap: {
        messages: { INBOX: inbox(1, 2) },
        messageMove: (_u, dest) => ({ path: 'INBOX', destination: dest, uidMap: new Map([[1, 900]]) }),
      },
    });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1), target(2)], ctx);
    expect(out.results.map((r) => r.status)).toEqual(['succeeded', 'failed']);
  });

  it('messageMove returning false marks the rows failed', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(1, 2) }, messageMove: () => false } });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1), target(2)], ctx);
    expect(out.results.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect([...s.actions.values()].map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(s.fake.logout).toHaveBeenCalled();
  });

  it('skips on UIDVALIDITY change without fetching or moving', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(1) } } });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1, { uidValidity: '12345' })], ctx);
    expect(out.results[0]).toMatchObject({ status: 'skipped', error: SKIP_UIDVALIDITY_CHANGED });
    expect(s.fake.messageMove).not.toHaveBeenCalled();
    expect([...s.actions.values()][0]).toMatchObject({ status: 'skipped', error: SKIP_UIDVALIDITY_CHANGED });
  });

  it('skips on Message-ID mismatch', async () => {
    const s = makeService({ imap: { messages: { INBOX: { 1: { messageId: '<other@example.com>' } } } } });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1)], ctx);
    expect(out.results[0]).toMatchObject({ status: 'skipped', error: SKIP_MESSAGE_ID_MISMATCH });
    expect(s.fake.messageMove).not.toHaveBeenCalled();
  });

  it('skips when neither Message-ID nor UIDVALIDITY is known', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(1) } } });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash(
      'acc1',
      [target(1, { messageId: null, uidValidity: null })],
      ctx,
    );
    expect(out.results[0]).toMatchObject({ status: 'skipped', error: SKIP_IDENTITY_UNVERIFIED });
    expect(s.fake.messageMove).not.toHaveBeenCalled();
  });

  it('skips a UID no longer in INBOX', async () => {
    const s = makeService({ imap: { messages: { INBOX: {} } } });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1)], ctx);
    expect(out.results[0]).toMatchObject({ status: 'skipped', error: SKIP_NOT_FOUND });
    expect(s.fake.messageMove).not.toHaveBeenCalled();
  });

  it('moves with an unchanged UIDVALIDITY when no Message-ID is stored', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(1) } } });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1, { messageId: null })], ctx);
    expect(out.results[0].status).toBe('succeeded');
    // Message-ID learnt from the envelope is recorded for undo.
    expect([...s.actions.values()][0].messageId).toBe('m1@example.com');
  });

  it('moves only the verified subset of a mixed chunk', async () => {
    const s = makeService({ imap: { messages: { INBOX: { ...inbox(1, 3), 2: { messageId: '<x@y>' } } } } });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1), target(2), target(3)], ctx);
    expect(s.fake.messageMove).toHaveBeenCalledWith([1, 3], TRASH, { uid: true });
    expect(Object.fromEntries(out.results.map((r) => [r.uid, r.status]))).toEqual({
      1: 'succeeded',
      2: 'skipped',
      3: 'succeeded',
    });
  });

  it('chunks into UID MOVEs of at most 50 on one connection', async () => {
    const uids = Array.from({ length: 120 }, (_, i) => i + 1);
    const s = makeService({ imap: { messages: { INBOX: inbox(...uids) } } });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', uids.map((u) => target(u)), ctx);
    expect(MOVE_CHUNK_SIZE).toBe(50);
    expect(s.fake.messageMove.mock.calls.map((c: unknown[]) => (c[0] as number[]).length)).toEqual([50, 50, 20]);
    expect(s.factory).toHaveBeenCalledTimes(1);
    expect(s.fake.connect).toHaveBeenCalledTimes(1);
    expect(s.fake.logout).toHaveBeenCalledTimes(1);
    expect(out.results.filter((r) => r.status === 'succeeded')).toHaveLength(120);
  });

  it('a throwing UID MOVE: re-check finds them still in INBOX → failed; later chunks aborted', async () => {
    const uids = Array.from({ length: 60 }, (_, i) => i + 1);
    const s = makeService({
      imap: {
        messages: { INBOX: inbox(...uids) },
        messageMove: () => {
          throw new Error('socket closed');
        },
      },
    });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', uids.map((u) => target(u)), ctx);
    expect(out.error).toBe('socket closed');
    expect(s.fake.messageMove).toHaveBeenCalledTimes(1);
    expect(out.results).toHaveLength(60);
    expect(out.results.every((r) => r.status === 'failed')).toBe(true);
    const rows = [...s.actions.values()];
    expect(rows).toHaveLength(50);
    expect(rows.every((r) => r.status === 'failed' && String(r.error).startsWith('not moved: UID MOVE threw'))).toBe(true);
    expect(s.fake.logout).toHaveBeenCalled();
  });

  it('a throwing UID MOVE whose re-check also fails → unknown (never failed), run aborted', async () => {
    const s = makeService({
      imap: {
        messages: { INBOX: inbox(1, 2) },
        recheckError: new Error('connection gone'),
        messageMove: () => {
          throw new Error('socket closed');
        },
      },
    });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1), target(2)], ctx);
    expect(out.error).toBe('socket closed');
    expect(out.results.map((r) => r.status)).toEqual(['unknown', 'unknown']);
    const rows = [...s.actions.values()];
    expect(rows.map((r) => r.status)).toEqual(['unknown', 'unknown']);
    expect(String(rows[0].error)).toMatch(/outcome unknown.*reconcile/);
  });

  it('messageMove false with a failing re-check → unknown', async () => {
    const s = makeService({
      imap: { messages: { INBOX: inbox(1) }, recheckError: new Error('gone'), messageMove: () => false },
    });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1)], ctx);
    expect(out.results[0].status).toBe('unknown');
    expect(out.error).toBeNull();
  });

  it('D2: a unique violation (P2002) on the pending insert skips only that message', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(1, 2) } } });
    forbiddenCalls = s.forbiddenCalls;
    // Another process wins the race after our pre-check ran.
    const realFindMany = s.db.mailboxAction.findMany.getMockImplementation()!;
    s.db.mailboxAction.findMany.mockImplementationOnce(async (args) => {
      const out = await realFindMany(args);
      s.insert({
        action: 'move_to_trash',
        status: 'pending',
        accountId: 'acc1',
        rawEmailId: 'raw1',
        sourceUid: 1,
        sourceUidValidity: INBOX_UIDVALIDITY,
      });
      return out;
    });
    const out = await s.service.moveToTrash('acc1', [target(1), target(2)], ctx);
    expect(Object.fromEntries(out.results.map((r) => [r.uid, [r.status, r.error]]))).toEqual({
      1: ['skipped', SKIP_IN_PROGRESS],
      2: ['succeeded', null],
    });
    expect(s.fake.messageMove).toHaveBeenCalledWith([2], TRASH, { uid: true });
  });

  it('a non-unique insert error closes the rows already written and moves nothing', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(1, 2) } } });
    forbiddenCalls = s.forbiddenCalls;
    const realCreate = s.db.mailboxAction.create.getMockImplementation()!;
    s.db.mailboxAction.create
      .mockImplementationOnce(realCreate)
      .mockImplementationOnce(async () => {
        throw new Error('db down');
      });
    const out = await s.service.moveToTrash('acc1', [target(1), target(2)], ctx);
    expect(out.error).toBe('db down');
    expect(s.fake.messageMove).not.toHaveBeenCalled();
    expect([...s.actions.values()].map((r) => [r.status, String(r.error).startsWith('not moved: audit insert failed')])).toEqual([
      ['failed', true],
    ]);
  });

  it('M2: never re-trashes a Message-ID that was trashed before (succeeded or undone)', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(1, 2, 3) } } });
    forbiddenCalls = s.forbiddenCalls;
    // Earlier moves of the same messages under other UIDs/RawEmails.
    s.insert({ action: 'move_to_trash', status: 'succeeded', accountId: 'acc1', rawEmailId: 'old1', sourceUid: 901, sourceUidValidity: '1', messageId: 'm1@example.com' });
    s.insert({ action: 'move_to_trash', status: 'undone', accountId: 'acc1', rawEmailId: 'old2', sourceUid: 902, sourceUidValidity: '1', messageId: 'm2@example.com' });
    // Another account's history does not count.
    s.insert({ action: 'move_to_trash', status: 'succeeded', accountId: 'acc2', rawEmailId: 'x', sourceUid: 903, sourceUidValidity: '1', messageId: 'm3@example.com' });
    const out = await s.service.moveToTrash('acc1', [target(1), target(2), target(3)], ctx);
    expect(Object.fromEntries(out.results.map((r) => [r.uid, [r.status, r.error]]))).toEqual({
      1: ['skipped', SKIP_PREVIOUSLY_TRASHED],
      2: ['skipped', SKIP_PREVIOUSLY_TRASHED],
      3: ['succeeded', null],
    });
    // Audited as skipped rows.
    expect([...s.actions.values()].filter((r) => r.error === SKIP_PREVIOUSLY_TRASHED)).toHaveLength(2);
  });

  it('always logs out: connect failure', async () => {
    const s = makeService({ imap: { connectError: new Error('ECONNREFUSED') } });
    forbiddenCalls = s.forbiddenCalls;
    await expect(s.service.moveToTrash('acc1', [target(1)], ctx)).rejects.toThrow('ECONNREFUSED');
    expect(s.fake.logout).toHaveBeenCalled();
  });

  it('always logs out: fetch failure, and nothing is moved', async () => {
    const s = makeService({ imap: { fetchError: new Error('fetch broke') } });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1)], ctx);
    expect(out.error).toBe('fetch broke');
    expect(out.results[0].status).toBe('failed');
    expect(s.fake.messageMove).not.toHaveBeenCalled();
    expect(s.log.slice(-2)).toEqual(['release:INBOX', 'logout']);
  });

  it('falls back to close() when logout throws', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(1) } } });
    forbiddenCalls = s.forbiddenCalls;
    s.fake.logout.mockRejectedValueOnce(new Error('gone'));
    await s.service.moveToTrash('acc1', [target(1)], ctx);
    expect(s.fake.close).toHaveBeenCalled();
  });

  it('refuses an overlapping write on the same account (409) and frees the lock afterwards', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(1, 2) } } });
    forbiddenCalls = s.forbiddenCalls;
    let release!: () => void;
    s.fake.connect.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const first = s.service.moveToTrash('acc1', [target(1)], ctx);
    await new Promise((r) => setImmediate(r));
    await expect(s.service.moveToTrash('acc1', [target(2)], ctx)).rejects.toBeInstanceOf(ConflictException);
    release();
    await first;
    await expect(s.service.moveToTrash('acc1', [target(2)], ctx)).resolves.toMatchObject({ error: null });
    expect(s.fake.messageMove).toHaveBeenCalledTimes(2);
  });

  it('messageMove false but the message left INBOX: recorded as succeeded (response lost)', async () => {
    const s = makeService({
      imap: {
        messages: { INBOX: inbox(1) },
        messageMove: (_u, _d, relocate) => {
          relocate();
          return false;
        },
      },
    });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1)], ctx);
    expect(out.results[0]).toMatchObject({ status: 'succeeded', destUid: null });
    expect([...s.actions.values()][0]).toMatchObject({
      status: 'succeeded',
      destUid: null,
      error: expect.stringContaining('confirmed by re-check'),
    });
  });

  it('UIDPLUS server, OK without COPYUID, message still in INBOX: failed', async () => {
    const s = makeService({
      imap: { messages: { INBOX: inbox(1) }, messageMove: (_u, dest) => ({ path: 'INBOX', destination: dest }) },
    });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1)], ctx);
    expect(out.results[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('still in INBOX') });
  });

  it('UIDPLUS server, OK without COPYUID, message gone: failed, not claimed as moved', async () => {
    const box = inbox(1);
    const s = makeService({
      imap: {
        messages: { INBOX: box },
        messageMove: (_u, dest) => {
          delete box[1]; // removed by someone else, not by this MOVE
          return { path: 'INBOX', destination: dest };
        },
      },
    });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1)], ctx);
    expect(out.results[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('no COPYUID from a UIDPLUS server') });
  });

  it('audit update failing after a successful MOVE reports the move and leaves rows pending', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(1) } } });
    forbiddenCalls = s.forbiddenCalls;
    s.db.$transaction.mockRejectedValueOnce(new Error('db down'));
    const out = await s.service.moveToTrash('acc1', [target(1)], ctx);
    expect(out.error).toBe('db down');
    expect(out.results).toEqual([
      expect.objectContaining({ status: 'succeeded', destUid: 1001, error: 'audit update failed: db down' }),
    ]);
    expect([...s.actions.values()][0].status).toBe('pending');
    expect(s.fake.logout).toHaveBeenCalled();
  });

  it('skips when a stored Message-ID meets an envelope without one', async () => {
    const s = makeService({ imap: { messages: { INBOX: { 1: { messageId: null } } } } });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1)], ctx);
    expect(out.results[0]).toMatchObject({ status: 'skipped', error: SKIP_MESSAGE_ID_MISMATCH });
    expect(s.fake.messageMove).not.toHaveBeenCalled();
  });

  it('skips a stored UIDVALIDITY when the server reports none', async () => {
    const s = makeService({ imap: { uidValidity: {}, messages: { INBOX: inbox(1) } } });
    forbiddenCalls = s.forbiddenCalls;
    const out = await s.service.moveToTrash('acc1', [target(1)], ctx);
    expect(out.results[0]).toMatchObject({ status: 'skipped', error: SKIP_UIDVALIDITY_CHANGED });
    expect(s.fake.messageMove).not.toHaveBeenCalled();
  });

  it('never moves mail another process already claimed (pending/succeeded by rawEmailId or UID)', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(1, 2, 3) } } });
    forbiddenCalls = s.forbiddenCalls;
    s.insert({ action: 'move_to_trash', status: 'pending', accountId: 'acc1', rawEmailId: 'raw1', sourceUid: 1 });
    s.insert({
      action: 'move_to_trash',
      status: 'succeeded',
      accountId: 'acc1',
      rawEmailId: 'rawOther',
      sourceUid: 2,
      sourceUidValidity: INBOX_UIDVALIDITY,
    });
    const out = await s.service.moveToTrash('acc1', [target(1), target(2), target(3)], ctx);
    expect(Object.fromEntries(out.results.map((r) => [r.uid, [r.status, r.error]]))).toEqual({
      1: ['skipped', SKIP_IN_PROGRESS],
      2: ['skipped', SKIP_IN_PROGRESS],
      3: ['succeeded', null],
    });
    expect(s.fake.messageMove).toHaveBeenCalledWith([3], TRASH, { uid: true });
  });

  it('the strict fake really rejects destructive calls', () => {
    const { client, forbiddenCalls: calls } = makeFakeClient([]);
    const anyClient = client as unknown as Record<string, () => unknown>;
    for (const name of FORBIDDEN) {
      expect(() => anyClient[name]()).toThrow(/forbidden IMAP call/);
    }
    expect(() => anyClient.somethingNew).toThrow(/unexpected ImapFlow member/);
    expect(calls).toHaveLength(FORBIDDEN.length + 1);
    forbiddenCalls = [];
  });
});

describe('findServerTrash', () => {
  it('needs exactly one extension-advertised \\Trash', () => {
    const t = (path: string, specialUseSource: string) =>
      ({ path, specialUse: '\\Trash', specialUseSource }) as never;
    expect(findServerTrash([t('A', 'extension')])?.path).toBe('A');
    expect(findServerTrash([t('A', 'name')])).toBeNull();
    expect(findServerTrash([t('A', 'extension'), t('B', 'extension')])).toBeNull();
    expect(findServerTrash([])).toBeNull();
  });
});

describe('MailboxWriterService.restore', () => {
  let forbiddenCalls: string[] = [];
  afterEach(() => expect(forbiddenCalls).toEqual([]));

  function seed(
    s: ReturnType<typeof makeService>,
    over: Record<string, unknown> = {},
  ) {
    s.rawEmails.set('raw10', { id: 'raw10', accountId: 'acc1', mailbox: 'INBOX', uid: 10 });
    return s.insert({
      action: 'move_to_trash',
      status: 'succeeded',
      accountId: 'acc1',
      rawEmailId: 'raw10',
      senderRuleId: 'rule1',
      sourceMailbox: 'INBOX',
      sourceUid: 10,
      sourceUidValidity: INBOX_UIDVALIDITY,
      destMailbox: TRASH,
      destUid: 1010,
      destUidValidity: TRASH_UIDVALIDITY,
      messageId: 'm10@example.com',
      gmailLabels: ['Promos'],
      ...over,
    });
  }

  const trashWith = (uid: number, messageId = '<m10@example.com>') => ({
    messages: { [TRASH]: { [uid]: { messageId } } },
  });

  it('kill switch off: 403 before any read, credential, or client', async () => {
    const s = makeService({ writesEnabled: false });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    await expect(s.service.restore(orig.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.db.mailboxAction.findUnique).not.toHaveBeenCalled();
    expect(s.accounts.getImapCredentials).not.toHaveBeenCalled();
    expect(s.factory).not.toHaveBeenCalled();
  });

  it('404 for an unknown action', async () => {
    const s = makeService();
    forbiddenCalls = s.forbiddenCalls;
    await expect(s.service.restore('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('happy path: moves destUid back to INBOX, links the restore row, relinks RawEmail', async () => {
    const s = makeService({ imap: trashWith(1010) });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);

    const { original, restore } = await s.service.restore(orig.id);

    expect(s.fake.getMailboxLock).toHaveBeenCalledWith(TRASH);
    expect(s.fake.messageMove).toHaveBeenCalledWith([1010], 'INBOX', { uid: true });
    // Restore row written (pending) before the MOVE.
    const createIdx = s.log.indexOf('db:create:restore:pending');
    const moveIdx = s.log.findIndex((l) => l.startsWith('messageMove:'));
    expect(createIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeLessThan(moveIdx);

    expect(original).toMatchObject({ id: orig.id, status: 'undone' });
    expect(original.undoneAt).toBeInstanceOf(Date);
    expect(restore).toMatchObject({
      action: 'restore',
      status: 'succeeded',
      undoOfId: orig.id,
      sourceMailbox: TRASH,
      sourceUid: 1010,
      destMailbox: 'INBOX',
      destUid: 2010,
      destUidValidity: INBOX_UIDVALIDITY,
      gmailLabels: [],
    });
    expect(s.rawEmails.get('raw10')).toMatchObject({ uid: 2010, uidValidity: INBOX_UIDVALIDITY });
    expect(s.fake.logout).toHaveBeenCalled();
  });

  it('does not relink RawEmail when another RawEmail already holds the restored UID', async () => {
    const s = makeService({ imap: trashWith(1010) });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    s.rawEmails.set('rawDup', { id: 'rawDup', accountId: 'acc1', mailbox: 'INBOX', uid: 2010 });

    await s.service.restore(orig.id);

    expect(s.db.rawEmail.update).not.toHaveBeenCalled();
    expect(s.rawEmails.get('raw10')).toMatchObject({ uid: 10 });
  });

  it('409 when the claim loses a race (updateMany count 0)', async () => {
    const s = makeService({ imap: trashWith(1010) });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    s.db.mailboxAction.updateMany.mockResolvedValueOnce({ count: 0 } as never);

    await expect(s.service.restore(orig.id)).rejects.toBeInstanceOf(ConflictException);
    expect(s.factory).not.toHaveBeenCalled();
  });

  it('double undo: the second call is 409 and moves nothing', async () => {
    const s = makeService({ imap: trashWith(1010) });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    await s.service.restore(orig.id);
    await expect(s.service.restore(orig.id)).rejects.toBeInstanceOf(ConflictException);
    expect(s.fake.messageMove).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'skipped', 'pending'])('409 for a %s original', async (status) => {
    const s = makeService();
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s, { status });
    await expect(s.service.restore(orig.id)).rejects.toBeInstanceOf(ConflictException);
    expect(s.factory).not.toHaveBeenCalled();
  });

  it('409 for a restore row', async () => {
    const s = makeService();
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s, { action: 'restore' });
    await expect(s.service.restore(orig.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('finds the message by Message-ID when Trash UIDVALIDITY changed', async () => {
    const s = makeService({ imap: trashWith(77) });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s, { destUidValidity: '1' });
    await s.service.restore(orig.id);
    expect(s.fake.search).toHaveBeenCalledWith({ header: { 'message-id': 'm10@example.com' } }, { uid: true });
    expect(s.fake.messageMove).toHaveBeenCalledWith([77], 'INBOX', { uid: true });
  });

  it('does not move a message at destUid whose Message-ID differs; falls back to search', async () => {
    const s = makeService({
      imap: { messages: { [TRASH]: { 1010: { messageId: '<someone-else@x>' }, 88: { messageId: '<m10@example.com>' } } } },
    });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    await s.service.restore(orig.id);
    expect(s.fake.messageMove).toHaveBeenCalledWith([88], 'INBOX', { uid: true });
  });

  it('502 when not found in Trash; claim released, nothing moved', async () => {
    const s = makeService({ imap: { messages: { [TRASH]: {} } } });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    await expect(s.service.restore(orig.id)).rejects.toBeInstanceOf(BadGatewayException);
    expect(s.fake.messageMove).not.toHaveBeenCalled();
    expect(s.actions.get(orig.id)?.status).toBe('succeeded');
    expect(s.fake.logout).toHaveBeenCalled();
  });

  it('502 when UID MOVE back returns false; restore row failed, original claim released', async () => {
    const s = makeService({ imap: { ...trashWith(1010), messageMove: () => false } });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    await expect(s.service.restore(orig.id)).rejects.toBeInstanceOf(BadGatewayException);
    expect(s.actions.get(orig.id)?.status).toBe('succeeded');
    const restoreRow = [...s.actions.values()].find((r) => r.action === 'restore');
    expect(restoreRow).toMatchObject({ status: 'failed' });
  });

  it('UID MOVE throwing during restore, message still in Trash: 502, restore row failed + unlinked, claim released', async () => {
    const s = makeService({
      imap: {
        ...trashWith(1010),
        messageMove: () => {
          throw new Error('socket closed');
        },
      },
    });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    await expect(s.service.restore(orig.id)).rejects.toBeInstanceOf(BadGatewayException);
    expect(s.actions.get(orig.id)?.status).toBe('succeeded');
    const restoreRow = [...s.actions.values()].find((r) => r.action === 'restore');
    expect(restoreRow).toMatchObject({ status: 'failed', undoOfId: null, error: expect.stringContaining('UID MOVE threw') });
  });

  it('UID MOVE throwing during restore with a failing re-check: restore row unknown (linked), original stays pending', async () => {
    const s = makeService({
      imap: {
        ...trashWith(1010),
        recheckError: new Error('gone'),
        messageMove: () => {
          throw new Error('socket closed');
        },
      },
    });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    await expect(s.service.restore(orig.id)).rejects.toBeInstanceOf(BadGatewayException);
    expect(s.actions.get(orig.id)?.status).toBe('pending');
    const restoreRow = [...s.actions.values()].find((r) => r.action === 'restore');
    expect(restoreRow).toMatchObject({ status: 'unknown', undoOfId: orig.id });
  });

  it('UID MOVE throwing but the message left Trash: restore recorded', async () => {
    const s = makeService({
      imap: {
        ...trashWith(1010),
        messageMove: (_u, _d, relocate) => {
          relocate();
          throw new Error('socket closed');
        },
      },
    });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    const { original, restore } = await s.service.restore(orig.id);
    expect(original.status).toBe('undone');
    expect(restore).toMatchObject({ status: 'succeeded', undoOfId: orig.id, error: expect.stringContaining('UID MOVE threw') });
  });

  it('ignores a corrupt destUid and falls back to Message-ID search', async () => {
    const s = makeService({ imap: trashWith(77) });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s, { destUid: 0 });
    await s.service.restore(orig.id);
    expect(s.fake.fetchOne).not.toHaveBeenCalledWith(0, expect.anything(), expect.anything());
    expect(s.fake.messageMove).toHaveBeenCalledWith([77], 'INBOX', { uid: true });
  });

  it('messageMove false but the message left Trash: restore recorded, UID found by Message-ID', async () => {
    const s = makeService({
      imap: {
        ...trashWith(1010),
        messageMove: (_u, _d, relocate) => {
          relocate();
          return false;
        },
      },
    });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    const { original, restore } = await s.service.restore(orig.id);
    expect(original.status).toBe('undone');
    expect(restore).toMatchObject({ status: 'succeeded', destUid: 2010, error: expect.stringContaining('re-check') });
    expect(s.rawEmails.get('raw10')).toMatchObject({ uid: 2010 });
  });

  it('no UIDPLUS: restored UID found in INBOX by Message-ID, then relinked', async () => {
    const s = makeService({
      imap: {
        ...trashWith(1010),
        capabilities: ['MOVE'],
        messageMove: (_u, dest, relocate) => {
          relocate();
          return { path: TRASH, destination: dest };
        },
      },
    });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    const { restore } = await s.service.restore(orig.id);
    expect(restore).toMatchObject({ status: 'succeeded', destUid: 2010, destUidValidity: INBOX_UIDVALIDITY, error: null });
    expect(s.fake.getMailboxLock).toHaveBeenLastCalledWith('INBOX');
    expect(s.rawEmails.get('raw10')).toMatchObject({ uid: 2010 });
  });

  it('UIDPLUS OK without COPYUID and the message still in Trash: 502, claim released', async () => {
    const s = makeService({
      imap: { ...trashWith(1010), messageMove: (_u, dest) => ({ path: TRASH, destination: dest }) },
    });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    await expect(s.service.restore(orig.id)).rejects.toBeInstanceOf(BadGatewayException);
    expect(s.actions.get(orig.id)?.status).toBe('succeeded');
  });

  it.each([
    ['a P2002 race', () => new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 't' })],
    ['an unexpected error', () => new Error('boom')],
  ])('relink failing with %s does not fail a recorded restore', async (_label, makeError) => {
    const s = makeService({ imap: trashWith(1010) });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    s.db.rawEmail.update.mockRejectedValueOnce(makeError());
    const { original } = await s.service.restore(orig.id);
    expect(original.status).toBe('undone');
  });

  it('a failed audit transaction after the MOVE throws and keeps the original claimed', async () => {
    const s = makeService({ imap: trashWith(1010) });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    s.db.$transaction.mockRejectedValueOnce(new Error('db down'));
    await expect(s.service.restore(orig.id)).rejects.toThrow('db down');
    expect(s.actions.get(orig.id)?.status).toBe('pending');
  });

  it('a restore overlapping a move on the same account is 409', async () => {
    const s = makeService({ imap: { messages: { INBOX: inbox(1), [TRASH]: { 1010: { messageId: '<m10@example.com>' } } } } });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    let release!: () => void;
    s.fake.connect.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const move = s.service.moveToTrash('acc1', [target(1)], ctx);
    await new Promise((r) => setImmediate(r));
    await expect(s.service.restore(orig.id)).rejects.toBeInstanceOf(ConflictException);
    expect(s.actions.get(orig.id)?.status).toBe('succeeded');
    release();
    await move;
  });

  it('refuses to restore without MOVE (502), claim released', async () => {
    const s = makeService({ imap: { ...trashWith(1010), capabilities: ['UIDPLUS'] } });
    forbiddenCalls = s.forbiddenCalls;
    const orig = seed(s);
    await expect(s.service.restore(orig.id)).rejects.toBeInstanceOf(BadGatewayException);
    expect(s.fake.messageMove).not.toHaveBeenCalled();
    expect(s.actions.get(orig.id)?.status).toBe('succeeded');
  });
});
