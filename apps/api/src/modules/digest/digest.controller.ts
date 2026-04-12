import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  ValidationPipe,
} from "@nestjs/common";
import { DigestService, DailyDigest } from "./digest.service";
import { GenerateDigestDto } from "./dto/generate-digest.dto";

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
    const date = dateStr ? new Date(dateStr) : new Date();
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
    const date = dto.date ? new Date(dto.date) : new Date();
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
