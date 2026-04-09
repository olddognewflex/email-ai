import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EmailAccount } from '@prisma/client';
import { DatabaseService } from '../database/database.service';
import { AppConfigService } from '../config/config.service';
import { encrypt, decrypt } from '../../common/crypto.util';
import { CreateEmailAccountDto } from './dto/create-email-account.dto';

export type EmailAccountResponse = Omit<EmailAccount, 'encryptedPassword'>;

@Injectable()
export class EmailAccountsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
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
    return decrypt(account.encryptedPassword, this.config.encryptionKey);
  }

  private toResponse(account: EmailAccount): EmailAccountResponse {
    const { encryptedPassword: _omit, ...rest } = account;
    return rest;
  }
}
