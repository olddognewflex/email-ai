import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  MailboxActionsListQuery,
  MailboxActionsListQuerySchema,
  MailboxReconcileQuery,
  MailboxReconcileQuerySchema,
} from '@email-ai/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MailboxActionsService } from './mailbox-actions.service';

@Controller('mailbox-actions')
export class MailboxActionsController {
  constructor(private readonly service: MailboxActionsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(MailboxActionsListQuerySchema))
    query: MailboxActionsListQuery,
  ) {
    return this.service.list(query);
  }

  // Declared before :id routes. Config only: never opens IMAP.
  @Get('status')
  status() {
    return this.service.status();
  }

  /**
   * Resolve `pending`/`unknown` rows by looking the messages up by
   * Message-ID in INBOX and Trash. Read-only on IMAP. Needs the kill
   * switch (and, like every POST, the X-Email-AI-Client header).
   */
  @Post('reconcile')
  @HttpCode(200)
  reconcile(
    @Query(new ZodValidationPipe(MailboxReconcileQuerySchema))
    query: MailboxReconcileQuery,
  ) {
    return this.service.reconcile(query);
  }

  /**
   * Move a trashed message back to INBOX. 403 when writes are disabled or
   * the X-Email-AI-Client header is missing, 404 unknown id, 409 not a
   * succeeded move (or already undone), 502 the message could not be found
   * in (or moved out of) Trash.
   */
  @Post(':id/undo')
  @HttpCode(200)
  undo(@Param('id') id: string) {
    return this.service.undo(id);
  }
}
