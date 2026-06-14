import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UsePipes,
} from '@nestjs/common';
import { EmailAccountsService } from './email-accounts.service';
import { CreateEmailAccountSchema } from './dto/create-email-account.dto';
import {
  UpdateEmailAccountSchema,
  UpdateEmailAccountDto,
} from './dto/update-email-account.dto';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

@Controller('email-accounts')
export class EmailAccountsController {
  constructor(private readonly service: EmailAccountsService) {}

  @Post()
  @UsePipes(new ZodValidationPipe(CreateEmailAccountSchema))
  create(@Body() dto: ReturnType<typeof CreateEmailAccountSchema.parse>) {
    return this.service.create(dto);
  }

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @UsePipes(new ZodValidationPipe(UpdateEmailAccountSchema))
  update(@Param('id') id: string, @Body() dto: UpdateEmailAccountDto) {
    return this.service.updateLabel(id, dto.label);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
