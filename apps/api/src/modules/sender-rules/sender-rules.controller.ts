import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  CreateSenderRule,
  CreateSenderRuleSchema,
  SenderRulePreviewRequest,
  SenderRulePreviewRequestSchema,
  SenderRuleSuggestionsQuery,
  SenderRuleSuggestionsQuerySchema,
  UpdateSenderRule,
  UpdateSenderRuleSchema,
} from "@email-ai/shared";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { SenderRulesService } from "./sender-rules.service";

@Controller("sender-rules")
export class SenderRulesController {
  constructor(private readonly service: SenderRulesService) {}

  @Get()
  list() {
    return this.service.list();
  }

  // Declared before the :id routes so "preview" is never read as an id.
  @Post("preview")
  @HttpCode(200)
  preview(
    @Body(new ZodValidationPipe(SenderRulePreviewRequestSchema))
    body: SenderRulePreviewRequest,
  ) {
    return this.service.preview(body);
  }

  // Read-only. Declared before :id so "suggestions" is never read as an id.
  @Get("suggestions")
  suggestions(
    @Query(new ZodValidationPipe(SenderRuleSuggestionsQuerySchema))
    query: SenderRuleSuggestionsQuery,
  ) {
    return this.service.suggestions(query);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.service.get(id);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateSenderRuleSchema))
    body: CreateSenderRule,
  ) {
    return this.service.create(body);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateSenderRuleSchema))
    body: UpdateSenderRule,
  ) {
    return this.service.update(id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id") id: string) {
    return this.service.remove(id);
  }
}
