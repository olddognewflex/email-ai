import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EmailAccount } from '@prisma/client';
import { DatabaseService } from '../database/database.service';
import { AppConfigService } from '../config/config.service';
import { encrypt, decrypt } from '../../common/crypto.util';
import {
  GoogleOAuthService,
  OAuthRevokedError,
} from '../google-oauth/google-oauth.service';
import { CreateEmailAccountDto } from './dto/create-email-account.dto';

export type EmailAccountResponse = Omit<
  EmailAccount,
  'encryptedPassword' | 'encryptedRefreshToken'
>;

export type ImapCredentials =
  | { kind: 'password'; password: string }
  | { kind: 'oauth'; accessToken: string };

const GMAIL_IMAP_HOST = 'imap.gmail.com';
const GMAIL_IMAP_PORT = 993;

@Injectable()
export class EmailAccountsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly googleOAuth: GoogleOAuthService,
  ) {}

  async create(dto: CreateEmailAccountDto): Promise<EmailAccountResponse> {
    const encryptedPassword = encrypt(dto.password, this.config.encryptionKey);
    const account = await this.db.emailAccount.create({
      data: {
        label: dto.label,
        host: dto.host,
        port: dto.port,
        username: dto.username,
        secure: dto.secure,
        encryptedPassword,
      },
    });
    return this.toResponse(account);
  }

  async findAll(): Promise<EmailAccountResponse[]> {
    const accounts = await this.db.emailAccount.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return accounts.map((a) => this.toResponse(a));
  }

  async findOne(id: string): Promise<EmailAccountResponse> {
    const account = await this.db.emailAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException(`EmailAccount ${id} not found`);
    return this.toResponse(account);
  }

  async remove(id: string): Promise<void> {
    const account = await this.db.emailAccount.findUnique({
      where: { id },
      include: { _count: { select: { rawEmails: true } } },
    });
    if (!account) throw new NotFoundException(`EmailAccount ${id} not found`);
    if (account._count.rawEmails > 0) {
      throw new ConflictException(
        `Cannot delete account with ${account._count.rawEmails} synced emails`,
      );
    }
    await this.db.emailAccount.delete({ where: { id } });
  }

  async getDecryptedPassword(id: string): Promise<string> {
    const account = await this.db.emailAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException(`EmailAccount ${id} not found`);
    if (account.authType !== 'password' || !account.encryptedPassword) {
      throw new BadRequestException(
        `EmailAccount ${id} does not use password auth`,
      );
    }
    return decrypt(account.encryptedPassword, this.config.encryptionKey);
  }

  async createOAuthAccount(input: {
    label: string;
    email: string;
    refreshToken: string;
  }): Promise<EmailAccountResponse> {
    const encryptedRefreshToken = encrypt(
      input.refreshToken,
      this.config.encryptionKey,
    );

    const existing = await this.db.emailAccount.findFirst({
      where: {
        authType: 'oauth',
        username: input.email,
        host: GMAIL_IMAP_HOST,
      },
    });

    if (existing) {
      const updated = await this.db.emailAccount.update({
        where: { id: existing.id },
        data: { encryptedRefreshToken, needsReauth: false },
      });
      return this.toResponse(updated);
    }

    const account = await this.db.emailAccount.create({
      data: {
        label: input.label,
        host: GMAIL_IMAP_HOST,
        port: GMAIL_IMAP_PORT,
        username: input.email,
        secure: true,
        authType: 'oauth',
        encryptedRefreshToken,
      },
    });
    return this.toResponse(account);
  }

  async updateRefreshToken(id: string, refreshToken: string): Promise<void> {
    await this.db.emailAccount.update({
      where: { id },
      data: {
        encryptedRefreshToken: encrypt(refreshToken, this.config.encryptionKey),
        needsReauth: false,
      },
    });
  }

  async markNeedsReauth(id: string): Promise<void> {
    await this.db.emailAccount.update({
      where: { id },
      data: { needsReauth: true },
    });
  }

  async getImapCredentials(id: string): Promise<ImapCredentials> {
    const account = await this.db.emailAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException(`EmailAccount ${id} not found`);

    if (account.authType === 'password') {
      if (!account.encryptedPassword) {
        throw new BadRequestException(`EmailAccount ${id} has no password`);
      }
      return {
        kind: 'password',
        password: decrypt(account.encryptedPassword, this.config.encryptionKey),
      };
    }

    if (!account.encryptedRefreshToken) {
      throw new BadRequestException(
        `EmailAccount ${id} has no OAuth refresh token`,
      );
    }
    const refreshToken = decrypt(
      account.encryptedRefreshToken,
      this.config.encryptionKey,
    );

    try {
      const minted = await this.googleOAuth.mintAccessToken(refreshToken);
      if (minted.newRefreshToken) {
        await this.updateRefreshToken(id, minted.newRefreshToken);
      }
      return { kind: 'oauth', accessToken: minted.accessToken };
    } catch (error) {
      if (error instanceof OAuthRevokedError) {
        await this.markNeedsReauth(id);
        throw new BadRequestException(
          `Google authorization revoked or expired for account ${id}. ` +
            `Re-connect via POST /email-accounts/oauth/google/start with accountId.`,
        );
      }
      throw error;
    }
  }

  private toResponse(account: EmailAccount): EmailAccountResponse {
    const {
      encryptedPassword: _password,
      encryptedRefreshToken: _refreshToken,
      ...rest
    } = account;
    return rest;
  }
}
