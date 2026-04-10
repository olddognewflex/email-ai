import { Module } from "@nestjs/common";
import { EmailNormalizer } from "./email-normalizer.service";
import { NormalizationController } from "./normalization.controller";
import { NormalizationService } from "./normalization.service";

@Module({
  controllers: [NormalizationController],
  providers: [NormalizationService, EmailNormalizer],
  exports: [NormalizationService, EmailNormalizer],
})
export class NormalizationModule {}
