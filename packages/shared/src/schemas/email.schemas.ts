import { z } from 'zod';

export const EmailAddressSchema = z.object({
  address: z.string(),
  name: z.string().optional(),
});

export const ParsedEmailDataSchema = z.object({
  subject: z.string().nullable(),
  fromAddress: z.string().nullable(),
  fromName: z.string().nullable(),
  toAddresses: z.array(EmailAddressSchema),
  ccAddresses: z.array(EmailAddressSchema),
  textBody: z.string().nullable(),
  htmlBody: z.string().nullable(),
  attachmentCount: z.number().int().min(0),
  hasUnsubscribe: z.boolean(),
});

export const NormalizedEmailDataSchema = z.object({
  senderDomain: z.string(),
  isNewsletter: z.boolean(),
  isBulk: z.boolean(),
  tags: z.array(z.string()),
});

export const SyncResultDataSchema = z.object({
  accountId: z.string(),
  mailbox: z.string(),
  fetchedCount: z.number().int().min(0),
  storedCount: z.number().int().min(0),
  dryRun: z.boolean(),
  lastUid: z.number().int().min(0),
});
