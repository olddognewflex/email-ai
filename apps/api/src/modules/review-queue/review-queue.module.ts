import { Module } from "@nestjs/common";
import { ReviewQueueController } from "./review-queue.controller";
import { ReviewQueueService } from "./review-queue.service";

@Module({
  controllers: [ReviewQueueController],
  providers: [ReviewQueueService],
  exports: [ReviewQueueService],
})
export class ReviewQueueModule {}
