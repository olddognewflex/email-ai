import { ImapFlow } from 'imapflow';
import { DatabaseService } from '../database/database.service';
import { AppConfigService } from '../config/config.service';
import { EmailAccountsService } from '../email-accounts/email-accounts.service';
import { EmailSyncService } from './email-sync.service';
import { SyncResult } from './email-sync.types';

jest.mock('imapflow', () => ({ ImapFlow: jest.fn() }));

const ImapFlowMock = ImapFlow as unknown as jest.Mock;

function makeService(accountIds: string[]) {
  const db = {
    emailAccount: {
      findMany: jest.fn().mockResolvedValue(accountIds.map((id) => ({ id }))),
    },
  };
  const service = new EmailSyncService(
    db as unknown as DatabaseService,
    {} as AppConfigService,
    {} as EmailAccountsService,
  );
  return { service, db };
}

function result(accountId: string): SyncResult {
  return {
    accountId,
    mailbox: 'INBOX',
    fetchedCount: 1,
    storedCount: 1,
    dryRun: false,
    lastUid: 1,
  };
}

describe('syncAll', () => {
  it('queries only active accounts', async () => {
    const { service, db } = makeService(['a']);
    jest
      .spyOn(service, 'syncAccount')
      .mockImplementation((id) => Promise.resolve(result(id)));

    await service.syncAll();

    expect(db.emailAccount.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      select: { id: true },
    });
  });

  it('passes options through to each account sync', async () => {
    const { service } = makeService(['a', 'b']);
    const spy = jest
      .spyOn(service, 'syncAccount')
      .mockImplementation((id) => Promise.resolve(result(id)));

    await service.syncAll({ dryRun: false, mailbox: 'Archive' });

    expect(spy).toHaveBeenCalledWith('a', { dryRun: false, mailbox: 'Archive' });
    expect(spy).toHaveBeenCalledWith('b', { dryRun: false, mailbox: 'Archive' });
  });

  it('aggregates results across all accounts', async () => {
    const { service } = makeService(['a', 'b']);
    jest
      .spyOn(service, 'syncAccount')
      .mockImplementation((id) => Promise.resolve(result(id)));

    const summary = await service.syncAll();

    expect(summary.total).toBe(2);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.results).toHaveLength(2);
    expect(summary.errors).toEqual([]);
  });

  it('isolates a failing account without aborting the batch', async () => {
    const { service } = makeService(['ok', 'bad', 'ok2']);
    jest.spyOn(service, 'syncAccount').mockImplementation((id) => {
      if (id === 'bad') return Promise.reject(new Error('inactive'));
      return Promise.resolve(result(id));
    });

    const summary = await service.syncAll();

    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.errors).toEqual([{ accountId: 'bad', error: 'inactive' }]);
    expect(summary.results.map((r) => r.accountId)).toEqual(['ok', 'ok2']);
  });
});

describe('syncAccount — uidValidity capture', () => {
  type Msg = { uid: number; source: Buffer; flags: Set<string>; internalDate: Date };

  function makeSyncService(mailbox: object | false, messages: Msg[]) {
    const release = jest.fn();
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      getMailboxLock: jest.fn().mockResolvedValue({ release }),
      mailbox,
      fetch: jest.fn(async function* () {
        for (const m of messages) yield m;
      }),
      logout: jest.fn().mockResolvedValue(undefined),
      close: jest.fn(),
    };
    ImapFlowMock.mockImplementation(() => client);

    const db = {
      emailAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'acc1',
          isActive: true,
          needsReauth: false,
          host: 'imap.example.com',
          port: 993,
          secure: true,
          username: 'me@example.com',
        }),
      },
      syncState: {
        upsert: jest.fn().mockResolvedValue({ id: 'ss1', lastSyncedUid: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      rawEmail: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const accounts = {
      getImapCredentials: jest
        .fn()
        .mockResolvedValue({ kind: 'password', password: 'x' }),
    };
    const service = new EmailSyncService(
      db as unknown as DatabaseService,
      {} as AppConfigService,
      accounts as unknown as EmailAccountsService,
    );
    return { service, db, client, release };
  }

  const msg = (uid: number): Msg => ({
    uid,
    source: Buffer.from(`Subject: ${uid}\r\n\r\nbody`),
    flags: new Set(['\\Seen']),
    internalDate: new Date('2026-09-01T00:00:00Z'),
  });

  afterEach(() => ImapFlowMock.mockReset());

  it('stores UIDVALIDITY as a decimal string, including values above 2^31', async () => {
    // 4294967295 = 2^32 - 1: overflows a signed Int column.
    const { service, db, release } = makeSyncService(
      { exists: 2, uidValidity: BigInt(4294967295) },
      [msg(7), msg(8)],
    );

    const result = await service.syncAccount('acc1', { dryRun: false });

    expect(result.storedCount).toBe(2);
    expect(db.rawEmail.upsert).toHaveBeenCalledTimes(2);
    for (const [args] of db.rawEmail.upsert.mock.calls) {
      expect(args.create.uidValidity).toBe('4294967295');
      // Existing rows are never touched (update stays empty), so rows
      // ingested before this column existed keep uidValidity null.
      expect(args.update).toEqual({});
    }
    expect(release).toHaveBeenCalled();
  });

  it('stores null when the server reports no UIDVALIDITY', async () => {
    const { service, db } = makeSyncService({ exists: 1 }, [msg(3)]);

    await service.syncAccount('acc1', { dryRun: false });

    expect(db.rawEmail.upsert.mock.calls[0][0].create.uidValidity).toBeNull();
  });

  it('writes nothing in dry-run mode', async () => {
    const { service, db } = makeSyncService(
      { exists: 1, uidValidity: BigInt(1234) },
      [msg(1)],
    );

    const result = await service.syncAccount('acc1');

    expect(result).toMatchObject({ dryRun: true, fetchedCount: 1, storedCount: 0 });
    expect(db.rawEmail.upsert).not.toHaveBeenCalled();
  });
});
