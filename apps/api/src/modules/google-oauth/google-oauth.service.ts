import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import * as crypto from 'crypto';
import { AppConfigService } from '../config/config.service';

export const GMAIL_OAUTH_SCOPES = ['https://mail.google.com/', 'email'];

const STATE_TTL_MS = 10 * 60 * 1000;

/** Thrown when Google reports the refresh token is revoked or expired. */
export class OAuthRevokedError extends Error {
  constructor(message = 'Google authorization revoked or expired') {
    super(message);
    this.name = 'OAuthRevokedError';
  }
}

export interface OAuthStatePayload {
  label?: string;
  accountId?: string;
}

interface StoredState extends OAuthStatePayload {
  createdAt: number;
}

@Injectable()
export class GoogleOAuthService {
  private readonly pendingStates = new Map<string, StoredState>();

  constructor(private readonly config: AppConfigService) {}

  createAuthUrl(payload: OAuthStatePayload): {
    authUrl: string;
    state: string;
    expiresInSeconds: number;
  } {
    const client = this.createClient();
    const state = crypto.randomBytes(16).toString('hex');
    this.pendingStates.set(state, { ...payload, createdAt: Date.now() });

    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GMAIL_OAUTH_SCOPES,
      state,
    });

    return { authUrl, state, expiresInSeconds: STATE_TTL_MS / 1000 };
  }

  consumeState(state: string): OAuthStatePayload {
    const stored = this.pendingStates.get(state);
    if (stored) this.pendingStates.delete(state);

    if (!stored || Date.now() - stored.createdAt > STATE_TTL_MS) {
      throw new BadRequestException(
        'OAuth state unknown or expired — restart the connect flow',
      );
    }

    const { createdAt: _omit, ...payload } = stored;
    return payload;
  }

  async exchangeCode(code: string): Promise<{
    refreshToken: string;
    accessToken: string;
    email: string;
  }> {
    const client = this.createClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.refresh_token) {
      throw new BadRequestException(
        'Google did not return a refresh token — revoke access at ' +
          'https://myaccount.google.com/permissions and retry',
      );
    }
    if (!tokens.access_token) {
      throw new BadRequestException('Google did not return an access token');
    }

    const info = await client.getTokenInfo(tokens.access_token);
    if (!info.email) {
      throw new BadRequestException(
        'Could not determine Google account email from token',
      );
    }

    return {
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      email: info.email,
    };
  }

  async mintAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    newRefreshToken?: string;
  }> {
    const client = this.createClient();
    client.setCredentials({ refresh_token: refreshToken });

    try {
      const { credentials } = await client.refreshAccessToken();
      if (!credentials.access_token) {
        throw new Error('Google returned no access token on refresh');
      }
      return {
        accessToken: credentials.access_token,
        newRefreshToken:
          credentials.refresh_token && credentials.refresh_token !== refreshToken
            ? credentials.refresh_token
            : undefined,
      };
    } catch (error) {
      if (this.isInvalidGrant(error)) {
        throw new OAuthRevokedError();
      }
      throw error;
    }
  }

  private isInvalidGrant(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as {
      message?: string;
      response?: { data?: { error?: string } };
    };
    return (
      err.response?.data?.error === 'invalid_grant' ||
      (err.message?.includes('invalid_grant') ?? false)
    );
  }

  private createClient(): OAuth2Client {
    if (!this.config.isGoogleOAuthConfigured) {
      throw new ServiceUnavailableException(
        'Google OAuth not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
      );
    }
    return new OAuth2Client(
      this.config.googleClientId,
      this.config.googleClientSecret,
      this.config.googleRedirectUri,
    );
  }
}
