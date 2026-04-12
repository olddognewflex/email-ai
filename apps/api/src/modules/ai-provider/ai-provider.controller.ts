import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  CreateAiProviderConfigSchema,
  UpdateAiProviderConfigSchema,
} from "@email-ai/shared";
import { AiProviderService } from "./ai-provider.service";
import { CreateAiProviderDto } from "./dto/create-ai-provider.dto";
import { UpdateAiProviderDto } from "./dto/update-ai-provider.dto";

@Controller("ai-providers")
export class AiProviderController {
  constructor(private readonly aiProviderService: AiProviderService) {}

  @Get()
  async getAllConfigs() {
    const configs = await this.aiProviderService.getAllConfigs();
    return configs.map((c) => this.sanitizeConfig(c));
  }

  @Get("available")
  getAvailableProviders() {
    return this.aiProviderService.getAvailableProviders();
  }

  @Get(":id")
  async getConfig(@Param("id") id: string) {
    const config = await this.aiProviderService.getConfig(id);
    if (!config) {
      return { error: "Provider configuration not found" };
    }
    return this.sanitizeConfig(config);
  }

  @Post()
  async createConfig(@Body() dto: CreateAiProviderDto) {
    const validated = CreateAiProviderConfigSchema.parse(dto);
    const config = await this.aiProviderService.createConfig(validated);
    return this.sanitizeConfig(config);
  }

  @Put(":id")
  async updateConfig(
    @Param("id") id: string,
    @Body() dto: UpdateAiProviderDto,
  ) {
    const validated = UpdateAiProviderConfigSchema.parse(dto);
    const config = await this.aiProviderService.updateConfig(id, validated);
    return this.sanitizeConfig(config);
  }

  @Post(":id/activate")
  @HttpCode(HttpStatus.OK)
  async setActiveProvider(@Param("id") id: string) {
    const config = await this.aiProviderService.setActiveProvider(id);
    return this.sanitizeConfig(config);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConfig(@Param("id") id: string) {
    await this.aiProviderService.deleteConfig(id);
  }

  private sanitizeConfig(config: {
    id: string;
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
    isActive: boolean;
    isEnabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: config.id,
      provider: config.provider,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      isActive: config.isActive,
      isEnabled: config.isEnabled,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }
}
