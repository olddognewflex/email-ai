import { Module } from "@nestjs/common";
import { AiProviderModule } from "../ai-provider/ai-provider.module";
import { ClassificationModule } from "../classification/classification.module";
import { SenderRuleReclassifyController } from "./sender-rule-reclassify.controller";
import { SenderRuleReclassifyService } from "./sender-rule-reclassify.service";

/**
 * POST /sender-rules/:id/reclassify and batch undo. A module of its own
 * because it needs ClassificationService, and ClassificationModule already
 * imports SenderRulesModule (rules are read straight from the database).
 */
@Module({
  imports: [AiProviderModule, ClassificationModule],
  controllers: [SenderRuleReclassifyController],
  providers: [SenderRuleReclassifyService],
})
export class SenderRuleReclassifyModule {}
