import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  Logger,
} from "@nestjs/common";
import { ReviewQueueService } from "./review-queue.service";

@Controller("review-queue")
export class ReviewQueueController {
  private readonly logger = new Logger(ReviewQueueController.name);

  constructor(private readonly reviewQueueService: ReviewQueueService) {}

  @Get()
  async getReviewQueue(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query("confidenceThreshold") confidenceThreshold?: string,
  ) {
    this.logger.log(
      `Fetching review queue: page=${page}, limit=${limit}, confidenceThreshold=${confidenceThreshold || "medium"}`,
    );

    const result = await this.reviewQueueService.getReviewQueue(
      page,
      limit,
      confidenceThreshold,
    );

    return {
      success: true,
      data: result.items,
      pagination: result.pagination,
    };
  }

  @Post(":id/approve")
  async approveClassification(@Param("id") id: string) {
    this.logger.log(`Approving classification ${id}`);

    const result = await this.reviewQueueService.approveClassification(id);

    return {
      success: true,
      data: result,
      message: "Classification approved successfully",
    };
  }

  @Post(":id/reject")
  async rejectClassification(@Param("id") id: string) {
    this.logger.log(`Rejecting classification ${id}`);

    const result = await this.reviewQueueService.rejectClassification(id);

    return {
      success: true,
      data: result,
      message: "Classification rejected successfully",
    };
  }
}
