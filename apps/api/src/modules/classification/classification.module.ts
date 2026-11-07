import { Module } from "@nestjs/common";
import { ClassificationController } from "./classification.controller";
import { ClassificationService } from "./classification.service";
import { AiProviderModule } from "../ai-provider/ai-provider.module";
import { SenderRulesModule } from "../sender-rules/sender-rules.module";
import { ReviewQueueModule } from "../review-queue/review-queue.module";

@Module({
  imports: [AiProviderModule, SenderRulesModule, ReviewQueueModule],
  controllers: [ClassificationController],
  providers: [ClassificationService],
  exports: [ClassificationService],
})
export class ClassificationModule {}
