import { Module } from "@nestjs/common";
import { MailboxActionsModule } from "../mailbox-actions/mailbox-actions.module";
import { SenderRulesApplyController } from "./sender-rules-apply.controller";
import { SenderRulesApplyService } from "./sender-rules-apply.service";
import { SenderRulesController } from "./sender-rules.controller";
import { SenderRulesService } from "./sender-rules.service";

@Module({
  imports: [MailboxActionsModule],
  // Apply controller first so POST /sender-rules/apply is registered
  // ahead of any future POST /sender-rules/:id route.
  controllers: [SenderRulesApplyController, SenderRulesController],
  providers: [SenderRulesService, SenderRulesApplyService],
  exports: [SenderRulesService],
})
export class SenderRulesModule {}
