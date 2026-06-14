import {
  BadRequestException,
  Body,
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
import { EmailCategorySchema } from "@email-ai/shared";
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

  @Get("actionable")
  async getActionableQueue(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    this.logger.log(`Fetching actionable queue: page=${page}, limit=${limit}`);

    const result = await this.reviewQueueService.getActionableQueue(
      page,
      limit,
    );

    return {
      success: true,
      data: result.items,
      pagination: result.pagination,
    };
  }

  @Get(":id")
  async getClassificationDetail(@Param("id") id: string) {
    const detail = await this.reviewQueueService.getClassificationDetail(id);

    return {
      success: true,
      data: detail,
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
  async rejectClassification(
    @Param("id") id: string,
    @Body() body?: { correctedCategory?: string },
  ) {
    let correctedCategory: string | undefined;
    if (body?.correctedCategory !== undefined) {
      const parsed = EmailCategorySchema.safeParse(body.correctedCategory);
      if (!parsed.success) {
        throw new BadRequestException(
          `Invalid correctedCategory: ${body.correctedCategory}. Valid: ${EmailCategorySchema.options.join(", ")}`,
        );
      }
      correctedCategory = parsed.data;
    }

    this.logger.log(
      `Rejecting classification ${id}` +
        (correctedCategory ? ` -> ${correctedCategory}` : ""),
    );

    const result = await this.reviewQueueService.rejectClassification(
      id,
      correctedCategory,
    );

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

    // Rejection is recorded; closing the tab here is fine. Picking a
    // category upgrades the rejection with a human override.
    const buttons = EmailCategorySchema.options
      .map(
        (category) =>
          `<a href="/review-queue/${id}/recategorize?category=${category}"
              style="display: inline-block; margin: 0.25rem; padding: 0.5rem 1rem;
                     border: 1px solid #888; border-radius: 6px;
                     text-decoration: none; color: inherit">${category}</a>`,
      )
      .join("\n");

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>✗ Rejected</title></head>
<body style="font-family: system-ui; text-align: center; margin-top: 4rem">
<h1>✗ Rejected</h1>
<p>Classification <code>${id}</code></p>
<p><strong>What should it have been?</strong> (optional — pick to store a correction)</p>
<p style="max-width: 32rem; margin: 1rem auto">${buttons}</p>
<p>Or just close this tab to leave it as rejected.</p>
</body></html>`;
  }

  @Get(":id/recategorize")
  @Header("Content-Type", "text/html")
  async recategorizeViaLink(
    @Param("id") id: string,
    @Query("category") category?: string,
  ): Promise<string> {
    const parsed = EmailCategorySchema.safeParse(category);
    if (!parsed.success) {
      throw new BadRequestException(
        `Invalid category: ${category}. Valid: ${EmailCategorySchema.options.join(", ")}`,
      );
    }

    this.logger.log(`Recategorizing classification ${id} -> ${parsed.data}`);
    await this.reviewQueueService.recategorizeClassification(id, parsed.data);
    return this.decisionPage(`✗ Rejected → ${parsed.data}`, id);
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
