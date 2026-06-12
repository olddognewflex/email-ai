import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpException,
  Post,
  Query,
  Res,
  UsePipes,
} from '@nestjs/common';
import { Response } from 'express';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { GoogleOAuthService } from '../google-oauth/google-oauth.service';
import { EmailAccountsService } from './email-accounts.service';
import {
  GoogleOAuthCallbackSchema,
  StartGoogleOAuthSchema,
} from './dto/google-oauth.dto';

@Controller('email-accounts/oauth/google')
export class GoogleOAuthController {
  constructor(
    private readonly googleOAuth: GoogleOAuthService,
    private readonly emailAccounts: EmailAccountsService,
  ) {}

  @Post('start')
  @UsePipes(new ZodValidationPipe(StartGoogleOAuthSchema))
  start(@Body() dto: ReturnType<typeof StartGoogleOAuthSchema.parse>) {
    return this.googleOAuth.createAuthUrl({
      label: dto.label,
      accountId: dto.accountId,
    });
  }

  @Get('callback')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async callback(
    @Query(new ZodValidationPipe(GoogleOAuthCallbackSchema))
    query: ReturnType<typeof GoogleOAuthCallbackSchema.parse>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    try {
      if (query.error) {
        throw new BadRequestException(`Authorization denied: ${query.error}`);
      }
      if (!query.code) {
        throw new BadRequestException('Missing authorization code');
      }

      const payload = this.googleOAuth.consumeState(query.state);
      const exchanged = await this.googleOAuth.exchangeCode(query.code);

      if (payload.accountId) {
        const account = await this.emailAccounts.findOne(payload.accountId);
        if (account.username !== exchanged.email) {
          throw new BadRequestException(
            `Consented Google account ${exchanged.email} does not match ` +
              `existing account username ${account.username}`,
          );
        }
        await this.emailAccounts.updateRefreshToken(
          payload.accountId,
          exchanged.refreshToken,
        );
        return this.page(
          'Gmail re-connected',
          `Re-authorized ${exchanged.email} — account ${payload.accountId}. You can close this tab.`,
        );
      }

      const created = await this.emailAccounts.createOAuthAccount({
        label: payload.label ?? 'Gmail',
        email: exchanged.email,
        refreshToken: exchanged.refreshToken,
      });
      return this.page(
        'Gmail connected',
        `Connected ${exchanged.email} — account ${created.id}. You can close this tab.`,
      );
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 502;
      const message =
        error instanceof Error ? error.message : 'Unexpected error';
      res.status(status);
      return this.page('Gmail connection failed', message);
    }
  }

  private page(title: string, body: string): string {
    return `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  }
}
