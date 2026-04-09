import { Module } from "@nestjs/common";
import { EmailSyncController } from "./email-sync.controller";
import { EmailSyncService } from "./email-sync.service";
import { ImapIngestionService } from "./imap-ingestion.service";
import { EmailAccountsModule } from "../email-accounts/email-accounts.module";

@Module({
  imports: [EmailAccountsModule],
  controllers: [EmailSyncController],
  providers: [EmailSyncService, ImapIngestionService],
  exports: [EmailSyncService, ImapIngestionService],
})
export class EmailSyncModule {}
