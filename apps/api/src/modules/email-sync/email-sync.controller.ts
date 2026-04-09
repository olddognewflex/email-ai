import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import { EmailSyncService } from "./email-sync.service";
import { ImapIngestionService } from "./imap-ingestion.service";

@Controller("email-sync")
export class EmailSyncController {
  constructor(
    private readonly service: EmailSyncService,
    private readonly ingestion: ImapIngestionService,
  ) {}

  @Post(":accountId/run")
  run(
    @Param("accountId") accountId: string,
    @Query("dryRun") dryRun = "true",
    @Query("mailbox") mailbox?: string,
  ) {
    return this.service.syncAccount(accountId, {
      dryRun: dryRun !== "false",
      mailbox,
    });
  }

  @Post(":accountId/ingest")
  ingest(
    @Param("accountId") accountId: string,
    @Query("dryRun") dryRun = "true",
    @Query("mailbox") mailbox?: string,
    @Query("limit") limit?: string,
  ) {
    return this.ingestion.ingestAccount(accountId, {
      dryRun: dryRun !== "false",
      mailbox,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(":accountId/states")
  states(@Param("accountId") accountId: string) {
    return this.service.listSyncStates(accountId);
  }
}
