import {
  BadRequestException,
  Controller,
  HttpCode,
  Logger,
  Post,
  Query,
} from "@nestjs/common";
import {
  AutoApproveService,
  BACKFILL_DEFAULT_LIMIT,
  BACKFILL_MAX_LIMIT,
} from "./auto-approve.service";

/**
 * POST /review/auto-approve?dryRun=true&limit=<n>: auto-approve existing
 * pending classifications (EMAIL-6). Dry run unless dryRun is exactly
 * "false". Writes ReviewDecision rows only; never touches the mailbox.
 * The global X-Email-AI-Client guard applies (POST).
 */
@Controller("review")
export class AutoApproveController {
  private readonly logger = new Logger(AutoApproveController.name);

  constructor(private readonly autoApprove: AutoApproveService) {}

  @Post("auto-approve")
  @HttpCode(200)
  async backfill(
    @Query("dryRun") dryRunParam?: string,
    @Query("limit") limitParam?: string,
  ) {
    const dryRun = dryRunParam !== "false";
    const limit = parseLimit(limitParam);
    this.logger.log(`Auto-approve backfill: dryRun=${dryRun}, limit=${limit}`);
    const data = await this.autoApprove.backfill({ dryRun, limit });
    return { success: true, data };
  }
}

/**
 * Default 500, max 5000. Out of range or non-integer is a 400, like the
 * sender-rule apply/reclassify endpoints, rather than a silent clamp.
 */
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return BACKFILL_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1 || n > BACKFILL_MAX_LIMIT) {
    throw new BadRequestException(
      `Invalid limit: ${raw}. Use an integer from 1 to ${BACKFILL_MAX_LIMIT}.`,
    );
  }
  return n;
}
