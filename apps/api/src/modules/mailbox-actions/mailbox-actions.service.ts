import { Injectable } from '@nestjs/common';
import { MailboxAction } from '@prisma/client';
import {
  MailboxActionsListQuery,
  MailboxReconcileQuery,
  MailboxReconcileResponse,
  MailboxWritesStatus,
} from '@email-ai/shared';
import { AppConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import { MailboxReconcileService } from './mailbox-reconcile.service';
import { MailboxWriterService, RestoreResult } from './mailbox-writer.service';

export type MailboxActionListItem = MailboxAction & {
  account: { label: string };
};

/**
 * Read side of the MailboxAction audit log, plus undo. Undo delegates to
 * MailboxWriterService, the only code that touches a mailbox.
 */
@Injectable()
export class MailboxActionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly writer: MailboxWriterService,
    private readonly reconciler: MailboxReconcileService,
  ) {}

  /** Kill-switch state. Reads config only: no IMAP, no database. */
  status(): MailboxWritesStatus {
    return { writesEnabled: this.config.mailboxWritesEnabled };
  }

  list(query: MailboxActionsListQuery): Promise<MailboxActionListItem[]> {
    return this.db.mailboxAction.findMany({
      where: {
        ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: { account: { select: { label: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });
  }

  undo(id: string): Promise<RestoreResult> {
    return this.writer.restore(id);
  }

  /** Read-only on IMAP: never reaches the writer. */
  reconcile(query: MailboxReconcileQuery): Promise<MailboxReconcileResponse> {
    return this.reconciler.reconcile(query);
  }
}
