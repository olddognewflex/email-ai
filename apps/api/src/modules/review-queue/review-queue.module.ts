import { Module } from "@nestjs/common";
import { ReviewQueueController } from "./review-queue.controller";
import { ReviewController } from "./review.controller";
import { ReviewQueueService } from "./review-queue.service";

@Module({
  controllers: [ReviewQueueController, ReviewController],
  providers: [ReviewQueueService],
  exports: [ReviewQueueService],
})
export class ReviewQueueModule {}
