import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from './env.schema';

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

  get nodeEnv(): string {
    return this.config.get('NODE_ENV', { infer: true });
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === 'development';
  }
}
