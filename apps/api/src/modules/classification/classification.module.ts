import { Module } from "@nestjs/common";
import { ClassificationController } from "./classification.controller";
import { ClassificationService } from "./classification.service";
import { AiProviderModule } from "../ai-provider/ai-provider.module";

@Module({
  imports: [AiProviderModule],
  controllers: [ClassificationController],
  providers: [ClassificationService],
  exports: [ClassificationService],
})
export class ClassificationModule {}
