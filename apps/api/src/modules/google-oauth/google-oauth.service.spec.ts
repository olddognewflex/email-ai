import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { GoogleOAuthService, OAuthRevokedError } from './google-oauth.service';

const generateAuthUrl = jest.fn();
const getToken = jest.fn();
const getTokenInfo = jest.fn();
const setCredentials = jest.fn();
const refreshAccessToken = jest.fn();

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    generateAuthUrl,
    getToken,
    getTokenInfo,
    setCredentials,
    refreshAccessToken,
  })),
}));

function makeService(configured = true): GoogleOAuthService {
  const config = {
    isGoogleOAuthConfigured: configured,
    googleClientId: configured ? 'client-id' : undefined,
    googleClientSecret: configured ? 'client-secret' : undefined,
    googleRedirectUri: 'http://localhost:3000/email-accounts/oauth/google/callback',
  } as unknown as AppConfigService;
  return new GoogleOAuthService(config);
}

beforeEach(() => {
  jest.clearAllMocks();
  generateAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/auth?mock');
});

describe('createAuthUrl', () => {
  it('throws ServiceUnavailable when not configured', () => {
    expect(() => makeService(false).createAuthUrl({})).toThrow(
      ServiceUnavailableException,
    );
  });

  it('requests offline access, forced consent, and the Gmail scope', () => {
    makeService().createAuthUrl({ label: 'Gmail' });
    expect(generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        access_type: 'offline',
        prompt: 'consent',
        scope: expect.arrayContaining(['https://mail.google.com/']),
        state: expect.any(String),
      }),
    );
  });

  it('returns the auth url and a state token', () => {
    const result = makeService().createAuthUrl({});
    expect(result.authUrl).toContain('https://accounts.google.com');
    expect(result.state).toMatch(/^[0-9a-f]{32}$/);
    expect(result.expiresInSeconds).toBe(600);
  });
});

describe('consumeState', () => {
  it('returns the stored payload and is single-use', () => {
    const service = makeService();
    const { state } = service.createAuthUrl({ label: 'Work', accountId: 'a1' });

    expect(service.consumeState(state)).toEqual({
      label: 'Work',
      accountId: 'a1',
    });
    expect(() => service.consumeState(state)).toThrow(BadRequestException);
  });

  it('rejects unknown state', () => {
    expect(() => makeService().consumeState('nope')).toThrow(
      BadRequestException,
    );
  });

  it('rejects expired state', () => {
    const service = makeService();
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const { state } = service.createAuthUrl({});

    nowSpy.mockReturnValue(now + 11 * 60 * 1000);
    expect(() => service.consumeState(state)).toThrow(BadRequestException);
    nowSpy.mockRestore();
  });
});

describe('exchangeCode', () => {
  it('returns tokens and the account email', async () => {
    getToken.mockResolvedValue({
      tokens: { refresh_token: 'rt', access_token: 'at' },
    });
    getTokenInfo.mockResolvedValue({ email: 'user@gmail.com' });

    await expect(makeService().exchangeCode('code')).resolves.toEqual({
      refreshToken: 'rt',
      accessToken: 'at',
      email: 'user@gmail.com',
    });
  });

  it('throws when Google omits the refresh token', async () => {
    getToken.mockResolvedValue({ tokens: { access_token: 'at' } });

    await expect(makeService().exchangeCode('code')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('mintAccessToken', () => {
  it('returns a fresh access token', async () => {
    refreshAccessToken.mockResolvedValue({
      credentials: { access_token: 'fresh' },
    });

    await expect(makeService().mintAccessToken('rt')).resolves.toEqual({
      accessToken: 'fresh',
      newRefreshToken: undefined,
    });
    expect(setCredentials).toHaveBeenCalledWith({ refresh_token: 'rt' });
  });

  it('surfaces a rotated refresh token', async () => {
    refreshAccessToken.mockResolvedValue({
      credentials: { access_token: 'fresh', refresh_token: 'rt2' },
    });

    await expect(makeService().mintAccessToken('rt')).resolves.toEqual({
      accessToken: 'fresh',
      newRefreshToken: 'rt2',
    });
  });

  it('maps invalid_grant to OAuthRevokedError', async () => {
    refreshAccessToken.mockRejectedValue(
      Object.assign(new Error('invalid_grant'), {
        response: { data: { error: 'invalid_grant' } },
      }),
    );

    await expect(makeService().mintAccessToken('rt')).rejects.toThrow(
      OAuthRevokedError,
    );
  });
});
