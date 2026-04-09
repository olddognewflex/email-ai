import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ParsedEmail, Prisma } from '@prisma/client';
import { type AddressObject, type ParsedMail, simpleParser } from 'mailparser';
import { DatabaseService } from '../database/database.service';
import { EmailAddress } from '@email-ai/shared';

function extractAddresses(
  field: AddressObject | AddressObject[] | undefined,
): EmailAddress[] {
  if (!field) return [];
  const objects = Array.isArray(field) ? field : [field];
  return objects.flatMap((obj) =>
    obj.value.map((addr) => ({
      address: addr.address ?? '',
      ...(addr.name ? { name: addr.name } : {}),
    })),
  );
}

@Injectable()
export class EmailParserService {
  private readonly logger = new Logger(EmailParserService.name);

  constructor(private readonly db: DatabaseService) {}

  async parseRawEmail(rawEmailId: string): Promise<ParsedEmail> {
    const raw = await this.db.rawEmail.findUnique({ where: { id: rawEmailId } });
    if (!raw) throw new NotFoundException(`RawEmail ${rawEmailId} not found`);

    const parsed: ParsedMail = await simpleParser(Buffer.from(raw.rawSource));

    const toAddresses = extractAddresses(parsed.to);
    const ccAddresses = extractAddresses(parsed.cc);
    const hasUnsubscribe = parsed.headers.has('list-unsubscribe');

    return this.db.parsedEmail.upsert({
      where: { rawEmailId },
      create: {
        rawEmailId,
        subject: parsed.subject ?? null,
        fromAddress: parsed.from?.value[0]?.address ?? null,
        fromName: parsed.from?.value[0]?.name ?? null,
        toAddresses: toAddresses as Prisma.InputJsonValue,
        ccAddresses: ccAddresses as Prisma.InputJsonValue,
        textBody: parsed.text ?? null,
        htmlBody: typeof parsed.html === 'string' ? parsed.html : null,
        attachmentCount: parsed.attachments?.length ?? 0,
        hasUnsubscribe,
      },
      update: {},
    });
  }

  async processUnparsed(): Promise<{ processed: number; errors: number }> {
    const unparsed = await this.db.rawEmail.findMany({
      where: { parsed: null },
      select: { id: true },
    });

    let processed = 0;
    let errors = 0;

    for (const { id } of unparsed) {
      try {
        await this.parseRawEmail(id);
        processed++;
      } catch (error) {
        this.logger.error(`Failed to parse raw email ${id}`, error);
        errors++;
      }
    }

    return { processed, errors };
  }
}
