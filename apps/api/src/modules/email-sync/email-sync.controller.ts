import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { EmailSyncService } from './email-sync.service';

@Controller('email-sync')
export class EmailSyncController {
  constructor(private readonly service: EmailSyncService) {}

  @Post(':accountId/run')
  run(
    @Param('accountId') accountId: string,
    @Query('dryRun') dryRun = 'true',
    @Query('mailbox') mailbox?: string,
  ) {
    return this.service.syncAccount(accountId, {
      dryRun: dryRun !== 'false',
      mailbox,
    });
  }

  @Get(':accountId/states')
  states(@Param('accountId') accountId: string) {
    return this.service.listSyncStates(accountId);
  }
}
