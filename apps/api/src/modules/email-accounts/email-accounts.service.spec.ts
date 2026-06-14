import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import {
  GoogleOAuthService,
  OAuthRevokedError,
} from '../google-oauth/google-oauth.service';
import { encrypt, decrypt } from '../../common/crypto.util';
import { EmailAccountsService } from './email-accounts.service';

const KEY = 'test-encryption-key';

function makeDb() {
  return {
    emailAccount: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
}

function makeService(overrides?: {
  db?: ReturnType<typeof makeDb>;
  googleOAuth?: Partial<GoogleOAuthService>;
}) {
  const db = overrides?.db ?? makeDb();
  const config = { encryptionKey: KEY } as AppConfigService;
  const googleOAuth = (overrides?.googleOAuth ?? {
    mintAccessToken: jest.fn(),
  }) as GoogleOAuthService;
  const service = new EmailAccountsService(
    db as unknown as DatabaseService,
    config,
    googleOAuth,
  );
  return { service, db, googleOAuth };
}

function oauthAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc1',
    label: 'Gmail',
    host: 'imap.gmail.com',
    port: 993,
    username: 'user@gmail.com',
    authType: 'oauth',
    encryptedPassword: null,
    encryptedRefreshToken: encrypt('refresh-token', KEY),
    needsReauth: false,
    secure: true,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('createOAuthAccount', () => {
  it('creates a gmail account with an encrypted refresh token', async () => {
    const { service, db } = makeService();
    db.emailAccount.findFirst.mockResolvedValue(null);
    db.emailAccount.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(oauthAccountRow(data)),
    );

    await service.createOAuthAccount({
      label: 'Personal',
      email: 'user@gmail.com',
      refreshToken: 'refresh-token',
    });

    const data = db.emailAccount.create.mock.calls[0][0].data;
    expect(data.host).toBe('imap.gmail.com');
    expect(data.port).toBe(993);
    expect(data.secure).toBe(true);
    expect(data.authType).toBe('oauth');
    expect(data.username).toBe('user@gmail.com');
    expect(data.encryptedRefreshToken).not.toContain('refresh-token');
    expect(decrypt(data.encryptedRefreshToken, KEY)).toBe('refresh-token');
  });

  it('updates the existing oauth account instead of duplicating', async () => {
    const { service, db } = makeService();
    db.emailAccount.findFirst.mockResolvedValue(oauthAccountRow());
    db.emailAccount.update.mockResolvedValue(oauthAccountRow());

    await service.createOAuthAccount({
      label: 'Personal',
      email: 'user@gmail.com',
      refreshToken: 'new-token',
    });

    expect(db.emailAccount.create).not.toHaveBeenCalled();
    const update = db.emailAccount.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 'acc1' });
    expect(update.data.needsReauth).toBe(false);
    expect(decrypt(update.data.encryptedRefreshToken, KEY)).toBe('new-token');
  });

  it('omits both secret fields from the response', async () => {
    const { service, db } = makeService();
    db.emailAccount.findFirst.mockResolvedValue(null);
    db.emailAccount.create.mockResolvedValue(oauthAccountRow());

    const response = await service.createOAuthAccount({
      label: 'Personal',
      email: 'user@gmail.com',
      refreshToken: 'refresh-token',
    });

    expect(response).not.toHaveProperty('encryptedPassword');
    expect(response).not.toHaveProperty('encryptedRefreshToken');
  });
});

describe('updateLabel', () => {
  it('updates the label of an existing account', async () => {
    const { service, db } = makeService();
    db.emailAccount.findUnique.mockResolvedValue(oauthAccountRow());
    db.emailAccount.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(oauthAccountRow(data)),
    );

    const response = await service.updateLabel('acc1', 'Acme Corp');

    const update = db.emailAccount.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 'acc1' });
    expect(update.data).toEqual({ label: 'Acme Corp' });
    expect(response.label).toBe('Acme Corp');
    expect(response).not.toHaveProperty('encryptedRefreshToken');
  });

  it('throws when the account does not exist', async () => {
    const { service, db } = makeService();
    db.emailAccount.findUnique.mockResolvedValue(null);

    await expect(service.updateLabel('missing', 'X')).rejects.toThrow(
      NotFoundException,
    );
    expect(db.emailAccount.update).not.toHaveBeenCalled();
  });
});

describe('getDecryptedPassword', () => {
  it('throws for oauth accounts', async () => {
    const { service, db } = makeService();
    db.emailAccount.findUnique.mockResolvedValue(oauthAccountRow());

    await expect(service.getDecryptedPassword('acc1')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('getImapCredentials', () => {
  it('returns the decrypted password for password accounts', async () => {
    const { service, db } = makeService();
    db.emailAccount.findUnique.mockResolvedValue(
      oauthAccountRow({
        authType: 'password',
        encryptedPassword: encrypt('secret', KEY),
        encryptedRefreshToken: null,
      }),
    );

    await expect(service.getImapCredentials('acc1')).resolves.toEqual({
      kind: 'password',
      password: 'secret',
    });
  });

  it('mints an access token for oauth accounts', async () => {
    const mintAccessToken = jest
      .fn()
      .mockResolvedValue({ accessToken: 'at' });
    const { service, db } = makeService({
      googleOAuth: { mintAccessToken },
    });
    db.emailAccount.findUnique.mockResolvedValue(oauthAccountRow());

    await expect(service.getImapCredentials('acc1')).resolves.toEqual({
      kind: 'oauth',
      accessToken: 'at',
    });
    expect(mintAccessToken).toHaveBeenCalledWith('refresh-token');
  });

  it('persists a rotated refresh token', async () => {
    const mintAccessToken = jest
      .fn()
      .mockResolvedValue({ accessToken: 'at', newRefreshToken: 'rotated' });
    const { service, db } = makeService({
      googleOAuth: { mintAccessToken },
    });
    db.emailAccount.findUnique.mockResolvedValue(oauthAccountRow());
    db.emailAccount.update.mockResolvedValue(oauthAccountRow());

    await service.getImapCredentials('acc1');

    const update = db.emailAccount.update.mock.calls[0][0];
    expect(decrypt(update.data.encryptedRefreshToken, KEY)).toBe('rotated');
    expect(update.data.needsReauth).toBe(false);
  });

  it('marks needsReauth and throws when authorization was revoked', async () => {
    const mintAccessToken = jest
      .fn()
      .mockRejectedValue(new OAuthRevokedError());
    const { service, db } = makeService({
      googleOAuth: { mintAccessToken },
    });
    db.emailAccount.findUnique.mockResolvedValue(oauthAccountRow());
    db.emailAccount.update.mockResolvedValue(oauthAccountRow());

    await expect(service.getImapCredentials('acc1')).rejects.toThrow(
      BadRequestException,
    );
    expect(db.emailAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc1' },
      data: { needsReauth: true },
    });
  });
});
