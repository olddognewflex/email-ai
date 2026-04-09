import { Module } from '@nestjs/common';
import { NormalizationController } from './normalization.controller';
import { NormalizationService } from './normalization.service';

@Module({
  controllers: [NormalizationController],
  providers: [NormalizationService],
  exports: [NormalizationService],
})
export class NormalizationModule {}
