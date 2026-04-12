import { Module } from "@nestjs/common";
import { AiProviderService } from "./ai-provider.service";
import { AiProviderController } from "./ai-provider.controller";

@Module({
  controllers: [AiProviderController],
  providers: [AiProviderService],
  exports: [AiProviderService],
})
export class AiProviderModule {}
