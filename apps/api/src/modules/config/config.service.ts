import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AutoApproveCategory, Env } from './env.schema';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get databaseUrl(): string {
    return this.config.get('DATABASE_URL', { infer: true });
  }

  get port(): number {
    return this.config.get('PORT', { infer: true });
  }

  get encryptionKey(): string {
    return this.config.get('ENCRYPTION_KEY', { infer: true });
  }

  get googleClientId(): string | undefined {
    return this.config.get('GOOGLE_CLIENT_ID', { infer: true });
  }

  get googleClientSecret(): string | undefined {
    return this.config.get('GOOGLE_CLIENT_SECRET', { infer: true });
  }

  get googleRedirectUri(): string {
    return (
      this.config.get('GOOGLE_REDIRECT_URI', { infer: true }) ??
      `http://localhost:${this.port}/email-accounts/oauth/google/callback`
    );
  }

  get isGoogleOAuthConfigured(): boolean {
    return Boolean(this.googleClientId && this.googleClientSecret);
  }

  /**
   * Kill switch for every IMAP mailbox write (move to Trash, restore).
   * False unless MAILBOX_WRITES_ENABLED is exactly "true". Read once at
   * startup: changing it requires an API restart.
   */
  get mailboxWritesEnabled(): boolean {
    return this.config.get('MAILBOX_WRITES_ENABLED', { infer: true }) === true;
  }

  /**
   * Auto-approve switch (EMAIL-6): high-confidence classifications in
   * `autoApproveCategories` get an `auto` approval. False unless
   * AUTO_APPROVE_ENABLED is exactly "true". Read once at startup.
   */
  get autoApproveEnabled(): boolean {
    return this.config.get('AUTO_APPROVE_ENABLED', { infer: true }) === true;
  }

  /** Validated AUTO_APPROVE_CATEGORIES (never contains `unknown`). */
  get autoApproveCategories(): readonly AutoApproveCategory[] {
    return this.config.get('AUTO_APPROVE_CATEGORIES', { infer: true });
  }

  get nodeEnv(): string {
    return this.config.get('NODE_ENV', { infer: true });
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === 'development';
  }
}
