import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { SyncStatus } from '@prisma/client';
import { ImapFlow } from 'imapflow';
import { DatabaseService } from '../database/database.service';
import { AppConfigService } from '../config/config.service';
import { EmailAccountsService } from '../email-accounts/email-accounts.service';
import { decrypt } from '../../common/crypto.util';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAILBOX,
  SyncOptions,
  SyncResult,
} from './email-sync.types';

@Injectable()
export class EmailSyncService implements OnModuleDestroy {
  private readonly logger = new Logger(EmailSyncService.name);
  private readonly activeConnections = new Map<string, ImapFlow>();

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly emailAccounts: EmailAccountsService,
  ) {}

  async syncAccount(
    accountId: string,
    options: Partial<SyncOptions> = {},
  ): Promise<SyncResult> {
    const mailbox = options.mailbox ?? DEFAULT_MAILBOX;
    const dryRun = options.dryRun ?? true;

    const account = await this.db.emailAccount.findUnique({
      where: { id: accountId },
    });
    if (!account) throw new NotFoundException(`EmailAccount ${accountId} not found`);
    if (!account.isActive) {
      throw new BadRequestException(`EmailAccount ${accountId} is inactive`);
    }

    const password = await this.emailAccounts.getDecryptedPassword(accountId);

    const syncState = await this.db.syncState.upsert({
      where: { accountId_mailbox: { accountId, mailbox } },
      create: { accountId, mailbox, lastSyncedUid: 0, status: SyncStatus.IDLE },
      update: {},
    });

    await this.db.syncState.update({
      where: { id: syncState.id },
      data: { status: SyncStatus.SYNCING },
    });

    const client = new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.secure,
      auth: { user: account.username, pass: password },
      logger: false,
    });

    let fetchedCount = 0;
    let storedCount = 0;
    let lastUid = syncState.lastSyncedUid;

    try {
      await client.connect();
      this.activeConnections.set(accountId, client);

      const lock = await client.getMailboxLock(mailbox);
      try {
        const mailboxInfo = client.mailbox;
        if (!mailboxInfo || mailboxInfo.exists === 0) {
          this.logger.log(`Mailbox ${mailbox} is empty for account ${accountId}`);
          return { accountId, mailbox, fetchedCount: 0, storedCount: 0, dryRun, lastUid };
        }

        const uidRange =
          syncState.lastSyncedUid === 0 ? '1:*' : `${syncState.lastSyncedUid + 1}:*`;

        for await (const msg of client.fetch(
          uidRange,
          { uid: true, source: true, flags: true, internalDate: true },
          { uid: true },
        )) {
          fetchedCount++;

          if (!dryRun && msg.source) {
            await this.db.rawEmail.upsert({
              where: {
                accountId_mailbox_uid: { accountId, mailbox, uid: msg.uid },
              },
              create: {
                accountId,
                mailbox,
                uid: msg.uid,
                rawSource: Buffer.from(msg.source),
                internalDate: msg.internalDate ?? new Date(),
                flags: Array.from(msg.flags ?? []),
              },
              update: {},
            });
            storedCount++;
            if (msg.uid > lastUid) lastUid = msg.uid;
          }
        }

        if (!dryRun) {
          await this.db.syncState.update({
            where: { id: syncState.id },
            data: { lastSyncedUid: lastUid, lastSyncedAt: new Date(), status: SyncStatus.IDLE },
          });
        } else {
          await this.db.syncState.update({
            where: { id: syncState.id },
            data: { status: SyncStatus.IDLE },
          });
        }

        this.logger.log(
          `Account ${accountId}: fetched=${fetchedCount} stored=${storedCount} dryRun=${dryRun}`,
        );
      } finally {
        lock.release();
      }
    } catch (error) {
      await this.db.syncState
        .update({ where: { id: syncState.id }, data: { status: SyncStatus.ERROR } })
        .catch(() => undefined);
      throw error;
    } finally {
      this.activeConnections.delete(accountId);
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }

    return { accountId, mailbox, fetchedCount, storedCount, dryRun, lastUid };
  }

  async onModuleDestroy(): Promise<void> {
    for (const [id, client] of this.activeConnections) {
      this.logger.warn(`Force-closing connection for account ${id}`);
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
    this.activeConnections.clear();
  }

  async listSyncStates(accountId: string) {
    return this.db.syncState.findMany({
      where: { accountId },
      orderBy: { mailbox: 'asc' },
    });
  }
}
