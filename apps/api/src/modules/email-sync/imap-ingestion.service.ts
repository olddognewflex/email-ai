import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { SyncStatus } from "@prisma/client";
import { MailClient } from "@email-ai/mail-client";
import { DatabaseService } from "../database/database.service";
import { EmailAccountsService } from "../email-accounts/email-accounts.service";

export interface IngestOptions {
  mailbox?: string;
  limit?: number;
  dryRun?: boolean;
}

export interface IngestResult {
  accountId: string;
  mailbox: string;
  fetchedCount: number;
  storedCount: number;
  lastUid: number;
  dryRun: boolean;
}

@Injectable()
export class ImapIngestionService {
  private readonly logger = new Logger(ImapIngestionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly emailAccounts: EmailAccountsService,
  ) {}

  async ingestAccount(
    accountId: string,
    options: IngestOptions = {},
  ): Promise<IngestResult> {
    const mailbox = options.mailbox ?? "INBOX";
    const limit = options.limit ?? 50;
    const dryRun = options.dryRun ?? true;

    const account = await this.db.emailAccount.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      throw new NotFoundException(`EmailAccount ${accountId} not found`);
    }

    if (!account.isActive) {
      throw new BadRequestException(`EmailAccount ${accountId} is inactive`);
    }

    const password = await this.emailAccounts.getDecryptedPassword(accountId);

    const syncState = await this.db.syncState.upsert({
      where: { accountId_mailbox: { accountId, mailbox } },
      create: {
        accountId,
        mailbox,
        lastSyncedUid: 0,
        status: SyncStatus.IDLE,
      },
      update: {},
    });

    await this.db.syncState.update({
      where: { id: syncState.id },
      data: { status: SyncStatus.SYNCING },
    });

    const client = new MailClient({
      host: account.host,
      port: account.port,
      username: account.username,
      password,
      secure: account.secure,
    });

    let fetchedCount = 0;
    let storedCount = 0;
    let lastUid = syncState.lastSyncedUid;

    try {
      await client.connect();
      this.logger.log(`Connected to IMAP for account ${accountId}`);

      const result = await client.fetchMessages({
        mailbox,
        limit,
        sinceUid: syncState.lastSyncedUid,
        newestFirst: true,
      });

      fetchedCount = result.messages.length;
      lastUid = result.lastUid;

      this.logger.log(
        `Fetched ${fetchedCount} messages from ${mailbox} ` +
          `(total in mailbox: ${result.totalMessages})`,
      );

      if (!dryRun) {
        for (const msg of result.messages) {
          try {
            await this.db.emailMessage.upsert({
              where: {
                accountId_mailbox_uid: {
                  accountId,
                  mailbox,
                  uid: msg.uid,
                },
              },
              create: {
                accountId,
                mailbox,
                uid: msg.uid,
                messageId: msg.messageId ?? null,
                subject: msg.subject ?? null,
                fromAddress: msg.from.address,
                fromName: msg.from.name ?? null,
                date: msg.date ?? null,
                body: msg.body,
                flags: msg.flags,
                internalDate: msg.internalDate,
              },
              update: {},
            });
            storedCount++;

            this.logger.debug(
              `Stored message: uid=${msg.uid}, subject="${msg.subject ?? "(no subject)"}"`,
            );
          } catch (error) {
            this.logger.error(
              `Failed to store message uid=${msg.uid}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        await this.db.syncState.update({
          where: { id: syncState.id },
          data: {
            lastSyncedUid: lastUid,
            lastSyncedAt: new Date(),
            status: SyncStatus.IDLE,
          },
        });

        this.logger.log(
          `Ingested ${storedCount} messages for account ${accountId}`,
        );
      } else {
        for (const msg of result.messages) {
          this.logger.debug(
            `[DRY RUN] Would store: uid=${msg.uid}, subject="${msg.subject ?? "(no subject)"}"`,
          );
        }

        await this.db.syncState.update({
          where: { id: syncState.id },
          data: { status: SyncStatus.IDLE },
        });

        this.logger.log(
          `[DRY RUN] Would ingest ${fetchedCount} messages for account ${accountId}`,
        );
      }
    } catch (error) {
      await this.db.syncState
        .update({
          where: { id: syncState.id },
          data: { status: SyncStatus.ERROR },
        })
        .catch(() => undefined);

      throw error;
    } finally {
      await client.disconnect();
      this.logger.log(`Disconnected from IMAP for account ${accountId}`);
    }

    return {
      accountId,
      mailbox,
      fetchedCount,
      storedCount,
      lastUid,
      dryRun,
    };
  }
}
