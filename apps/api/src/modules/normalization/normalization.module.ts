import { Module } from "@nestjs/common";
import { EmailNormalizer } from "./email-normalizer.service";
import { NormalizationController } from "./normalization.controller";
import { NormalizationService } from "./normalization.service";
import { RulesEngineService } from "../rules-engine/rules-engine.service";

@Module({
  controllers: [NormalizationController],
  providers: [NormalizationService, EmailNormalizer, RulesEngineService],
  exports: [NormalizationService, EmailNormalizer],
})
export class NormalizationModule {}
