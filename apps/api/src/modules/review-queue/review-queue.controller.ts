import {
  Controller,
  Get,
  Header,
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

  // GET variants exist so digest markdown links work from Obsidian,
  // which can only open URLs in a browser (no POST). Side-effectful
  // GET is acceptable for this single-user localhost tool.

  @Get(":id/approve")
  @Header("Content-Type", "text/html")
  async approveViaLink(@Param("id") id: string): Promise<string> {
    this.logger.log(`Approving classification ${id} (via link)`);
    await this.reviewQueueService.approveClassification(id);
    return this.decisionPage("✓ Approved", id);
  }

  @Get(":id/reject")
  @Header("Content-Type", "text/html")
  async rejectViaLink(@Param("id") id: string): Promise<string> {
    this.logger.log(`Rejecting classification ${id} (via link)`);
    await this.reviewQueueService.rejectClassification(id);
    return this.decisionPage("✗ Rejected", id);
  }

  private decisionPage(verdict: string, id: string): string {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${verdict}</title></head>
<body style="font-family: system-ui; text-align: center; margin-top: 4rem">
<h1>${verdict}</h1>
<p>Classification <code>${id}</code></p>
<p>You can close this tab. The change appears in the next digest.</p>
</body></html>`;
  }
}
