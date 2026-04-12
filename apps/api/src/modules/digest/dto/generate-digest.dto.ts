import { IsOptional, IsString, IsBoolean, IsISO8601 } from "class-validator";

export class GenerateDigestDto {
  /**
   * Output path for the markdown file.
   * Should be the path to your Obsidian vault or a directory.
   * @example "/Users/name/Documents/ObsidianVault/DailyNotes"
   */
  @IsString()
  outputPath!: string;

  /**
   * Date for the digest (ISO 8601 format).
   * Defaults to today if not provided.
   * @example "2025-04-12"
   */
  @IsOptional()
  @IsISO8601()
  date?: string;

  /**
   * Whether to include unreviewed classifications.
   * If false, only approved classifications are included.
   * @default true
   */
  @IsOptional()
  @IsBoolean()
  includeUnreviewed?: boolean;
}
