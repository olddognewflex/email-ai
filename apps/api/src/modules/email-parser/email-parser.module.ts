import { Module } from '@nestjs/common';
import { EmailParserController } from './email-parser.controller';
import { EmailParserService } from './email-parser.service';

@Module({
  controllers: [EmailParserController],
  providers: [EmailParserService],
  exports: [EmailParserService],
})
export class EmailParserModule {}
