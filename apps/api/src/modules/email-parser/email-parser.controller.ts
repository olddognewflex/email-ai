import { Controller, Param, Post } from '@nestjs/common';
import { EmailParserService } from './email-parser.service';

@Controller('email-parser')
export class EmailParserController {
  constructor(private readonly service: EmailParserService) {}

  @Post('run')
  run() {
    return this.service.processUnparsed();
  }

  @Post(':rawEmailId/parse')
  parseOne(@Param('rawEmailId') rawEmailId: string) {
    return this.service.parseRawEmail(rawEmailId);
  }
}
