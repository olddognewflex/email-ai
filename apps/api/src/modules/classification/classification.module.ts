import { Module } from "@nestjs/common";
import { ClassificationController } from "./classification.controller";
import { ClassificationService } from "./classification.service";
import { AiProviderModule } from "../ai-provider/ai-provider.module";
import { SenderRulesModule } from "../sender-rules/sender-rules.module";

@Module({
  imports: [AiProviderModule, SenderRulesModule],
  controllers: [ClassificationController],
  providers: [ClassificationService],
  exports: [ClassificationService],
})
export class ClassificationModule {}
