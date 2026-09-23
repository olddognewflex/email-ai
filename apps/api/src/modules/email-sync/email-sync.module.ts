import { Module } from "@nestjs/common";
import { EmailSyncController } from "./email-sync.controller";
import { EmailSyncService } from "./email-sync.service";
import { ImapIngestionService } from "./imap-ingestion.service";
import { EmailAccountsModule } from "../email-accounts/email-accounts.module";
import {
  IMAP_CLIENT_FACTORY,
  imapClientFactoryProvider,
} from "./imap-client.factory";

@Module({
  imports: [EmailAccountsModule],
  controllers: [EmailSyncController],
  providers: [EmailSyncService, ImapIngestionService, imapClientFactoryProvider],
  exports: [EmailSyncService, ImapIngestionService, IMAP_CLIENT_FACTORY],
})
export class EmailSyncModule {}
