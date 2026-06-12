import { Module } from '@nestjs/common';
import { GoogleOAuthModule } from '../google-oauth/google-oauth.module';
import { EmailAccountsController } from './email-accounts.controller';
import { GoogleOAuthController } from './google-oauth.controller';
import { EmailAccountsService } from './email-accounts.service';

@Module({
  imports: [GoogleOAuthModule],
  controllers: [EmailAccountsController, GoogleOAuthController],
  providers: [EmailAccountsService],
  exports: [EmailAccountsService],
})
export class EmailAccountsModule {}
