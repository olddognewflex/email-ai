import { z } from 'zod';
import {
  EmailAddressSchema,
  NormalizedEmailDataSchema,
  ParsedEmailDataSchema,
  SyncResultDataSchema,
} from '../schemas/email.schemas';

export type EmailAddress = z.infer<typeof EmailAddressSchema>;
export type ParsedEmailData = z.infer<typeof ParsedEmailDataSchema>;
export type NormalizedEmailData = z.infer<typeof NormalizedEmailDataSchema>;
export type SyncResultData = z.infer<typeof SyncResultDataSchema>;
