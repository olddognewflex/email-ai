import { Controller, HttpCode, Param, Post, Query } from "@nestjs/common";
import {
  SenderRuleReclassifyQuery,
  SenderRuleReclassifyQuerySchema,
} from "@email-ai/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { SenderRuleReclassifyService } from "./sender-rule-reclassify.service";

/**
 * Re-run a sender rule over mail that is already classified. Database
 * only: no mailbox access. Like every POST these need the
 * X-Email-AI-Client header (global guard).
 */
@Controller("sender-rules")
export class SenderRuleReclassifyController {
  constructor(private readonly service: SenderRuleReclassifyService) {}

  // Declared before :id/reclassify so "reclassify-batches" is never an id.
  @Post("reclassify-batches/:batchId/undo")
  @HttpCode(200)
  undo(@Param("batchId") batchId: string) {
    return this.service.undoBatch(batchId);
  }

  /** Dry run unless `dryRun` is exactly "false". */
  @Post(":id/reclassify")
  @HttpCode(200)
  reclassify(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(SenderRuleReclassifyQuerySchema))
    query: SenderRuleReclassifyQuery,
  ) {
    return this.service.reclassify(id, query);
  }
}
