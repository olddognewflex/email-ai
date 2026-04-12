import { Controller, Post, Param, Get, Logger } from "@nestjs/common";
import { ClassificationService } from "./classification.service";

@Controller("classification")
export class ClassificationController {
  private readonly logger = new Logger(ClassificationController.name);

  constructor(private readonly classificationService: ClassificationService) {}

  @Post("run")
  async processAll(): Promise<{
    processed: number;
    errors: number;
    needsReview: number;
  }> {
    this.logger.log("Processing all unclassified emails");
    return this.classificationService.processUnclassified();
  }

  @Post(":id/classify")
  async classifyOne(@Param("id") id: string) {
    this.logger.log(`Classifying email ${id}`);
    const result = await this.classificationService.classifyEmail(id);
    return {
      id: result.id,
      category: result.category,
      importance: result.importance,
      urgency: result.urgency,
      recommendedAction: result.recommendedAction,
      confidence: result.confidence,
      needsReview: result.needsReview,
      reason: result.reason,
      createdAt: result.createdAt,
    };
  }
}
