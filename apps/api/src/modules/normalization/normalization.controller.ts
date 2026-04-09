import { Controller, Param, Post } from '@nestjs/common';
import { NormalizationService } from './normalization.service';

@Controller('normalization')
export class NormalizationController {
  constructor(private readonly service: NormalizationService) {}

  @Post('run')
  run() {
    return this.service.processUnnormalized();
  }

  @Post(':parsedEmailId/normalize')
  normalizeOne(@Param('parsedEmailId') parsedEmailId: string) {
    return this.service.normalizeEmail(parsedEmailId);
  }
}
