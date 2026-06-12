import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ClassificationService } from "./classification.service";

@Controller("classification")
export class ClassificationController {
  private readonly logger = new Logger(ClassificationController.name);

  constructor(private readonly classificationService: ClassificationService) {}

  @Post("run")
  async processAll(
    @Query("since") since?: string,
    @Query("all") all?: string,
  ): Promise<{
    processed: number;
    errors: number;
    needsReview: number;
  }> {
    // Default to today's mail only; backfill is opt-in via ?all=true
    // or an explicit ?since=YYYY-MM-DD cutoff.
    let cutoff: Date | undefined;
    if (all !== "true") {
      if (since) {
        cutoff = new Date(since);
        if (isNaN(cutoff.getTime())) {
          throw new BadRequestException(
            `Invalid since date: ${since} (expected YYYY-MM-DD)`,
          );
        }
      } else {
        cutoff = new Date();
        cutoff.setHours(0, 0, 0, 0);
      }
    }

    this.logger.log(
      cutoff
        ? `Processing unclassified emails received since ${cutoff.toISOString()}`
        : "Processing ALL unclassified emails",
    );
    return this.classificationService.processUnclassified(cutoff);
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

  @Get("stats")
  async getStats() {
    return this.classificationService.getStats();
  }
}
