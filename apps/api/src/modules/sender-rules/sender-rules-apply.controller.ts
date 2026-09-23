import { Controller, HttpCode, Post, Query } from "@nestjs/common";
import {
  SenderRuleApplyQuery,
  SenderRuleApplyQuerySchema,
} from "@email-ai/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { SenderRulesApplyService } from "./sender-rules-apply.service";

/**
 * POST /sender-rules/apply. Kept apart from SenderRulesController so the
 * rules CRUD surface has no path to the mailbox writer.
 */
@Controller("sender-rules")
export class SenderRulesApplyController {
  constructor(private readonly service: SenderRulesApplyService) {}

  /**
   * Dry run unless `dryRun` is exactly "false". dryRun=false with
   * MAILBOX_WRITES_ENABLED off is a 403, never a silent dry run. Like
   * every POST it needs the X-Email-AI-Client header (global guard).
   */
  @Post("apply")
  @HttpCode(200)
  apply(
    @Query(new ZodValidationPipe(SenderRuleApplyQuerySchema))
    query: SenderRuleApplyQuery,
  ) {
    return this.service.apply(query);
  }
}
