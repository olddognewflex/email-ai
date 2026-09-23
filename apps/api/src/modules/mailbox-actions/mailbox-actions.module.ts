import { Module } from '@nestjs/common';
import { EmailAccountsModule } from '../email-accounts/email-accounts.module';
import { EmailSyncModule } from '../email-sync/email-sync.module';
import { MailboxActionsController } from './mailbox-actions.controller';
import { MailboxActionsService } from './mailbox-actions.service';
import { MailboxReconcileService } from './mailbox-reconcile.service';
import { MailboxWriterService } from './mailbox-writer.service';

@Module({
  // EmailSyncModule provides IMAP_CLIENT_FACTORY.
  imports: [EmailAccountsModule, EmailSyncModule],
  controllers: [MailboxActionsController],
  providers: [MailboxActionsService, MailboxWriterService, MailboxReconcileService],
  exports: [MailboxWriterService],
})
export class MailboxActionsModule {}
