import { Module } from "@nestjs/common";
import { SenderRulesController } from "./sender-rules.controller";
import { SenderRulesService } from "./sender-rules.service";

@Module({
  controllers: [SenderRulesController],
  providers: [SenderRulesService],
  exports: [SenderRulesService],
})
export class SenderRulesModule {}
