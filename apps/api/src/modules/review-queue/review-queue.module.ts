import { Module } from "@nestjs/common";
import { AutoApproveController } from "./auto-approve.controller";
import { AutoApproveService } from "./auto-approve.service";
import { ReviewQueueController } from "./review-queue.controller";
import { ReviewController } from "./review.controller";
import { ReviewQueueService } from "./review-queue.service";

@Module({
  controllers: [ReviewQueueController, ReviewController, AutoApproveController],
  providers: [ReviewQueueService, AutoApproveService],
  exports: [ReviewQueueService, AutoApproveService],
})
export class ReviewQueueModule {}
