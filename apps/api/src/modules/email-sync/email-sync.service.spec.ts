import { DatabaseService } from '../database/database.service';
import { AppConfigService } from '../config/config.service';
import { EmailAccountsService } from '../email-accounts/email-accounts.service';
import { EmailSyncService } from './email-sync.service';
import { SyncResult } from './email-sync.types';

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
