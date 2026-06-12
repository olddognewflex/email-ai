import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  Body,
  ValidationPipe,
} from "@nestjs/common";
import { DigestService, DailyDigest } from "./digest.service";
import { GenerateDigestDto } from "./dto/generate-digest.dto";

/**
 * Parse YYYY-MM-DD as a LOCAL date. new Date("YYYY-MM-DD") parses as
 * UTC midnight, which lands on the previous local calendar day in
 * timezones behind UTC and silently shifts the digest window.
 */
function parseLocalDate(dateStr?: string): Date {
  if (!dateStr) {
    return new Date();
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    throw new BadRequestException(
      `Invalid date: ${dateStr} (expected YYYY-MM-DD)`,
    );
  }
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  if (isNaN(date.getTime())) {
    throw new BadRequestException(`Invalid date: ${dateStr}`);
  }
  return date;
}

@Controller("digest")
export class DigestController {
  constructor(private readonly digestService: DigestService) {}

  /**
   * Generate a daily digest for a specific date.
   * Returns the digest data as JSON.
   */
  @Get()
  async getDigest(
    @Query("date") dateStr?: string,
  ): Promise<{ success: boolean; data: DailyDigest }> {
    const date = parseLocalDate(dateStr);
    const digest = await this.digestService.generateDigest({ date });

    return {
      success: true,
      data: digest,
    };
  }

  /**
   * Generate and save a digest to the file system.
   * Creates an Obsidian-compatible markdown file.
   */
  @Post("generate")
  async generateAndSave(
    @Body(new ValidationPipe({ transform: true })) dto: GenerateDigestDto,
  ): Promise<{
    success: boolean;
    data: { filePath: string; digest: DailyDigest };
    message: string;
  }> {
    const date = parseLocalDate(dto.date);
    const { digest, filePath } = await this.digestService.generateAndSaveDigest(
      {
        date,
        outputPath: dto.outputPath,
        includeUnreviewed: dto.includeUnreviewed ?? true,
      },
    );

    return {
      success: true,
      data: { filePath, digest },
      message: `Digest saved to ${filePath}`,
    };
  }
}
