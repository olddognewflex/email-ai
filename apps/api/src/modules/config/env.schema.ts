import { z } from 'zod';
import { EmailCategorySchema } from '@email-ai/shared';

export const DEFAULT_AUTO_APPROVE_CATEGORIES = [
  'newsletter',
  'marketing',
  'archive',
  'receipt',
] as const;

/**
 * Categories auto-approval may apply to: every EmailCategory except
 * `unknown`, which is the failure/fallback bucket and always needs a human.
 */
export const AutoApproveCategorySchema = EmailCategorySchema.exclude(['unknown']);
export type AutoApproveCategory = z.infer<typeof AutoApproveCategorySchema>;

/**
 * Comma-separated category list. Unset or blank uses the default, so
 * clearing the line can't stop the API from starting. Entries are
 * trimmed and de-duplicated, and empty ones (stray commas) are ignored.
 * Any entry that is not a valid EmailCategory, or is `unknown`, fails
 * validation (and so startup).
 */
const autoApproveCategoriesSchema = z
  .string()
  .optional()
  .transform((v) => {
    const entries = (v ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    return entries.length === 0
      ? [...DEFAULT_AUTO_APPROVE_CATEGORIES]
      : [...new Set(entries)];
  })
  .pipe(z.array(AutoApproveCategorySchema).min(1));

export const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  ENCRYPTION_KEY: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  // Mailbox-write kill switch. Fail-closed: only the exact string "true"
  // enables writes. Never z.coerce.boolean(), which turns "false" into true.
  MAILBOX_WRITES_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Auto-approve switch (EMAIL-6). Same fail-closed rule: only "true".
  AUTO_APPROVE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  AUTO_APPROVE_CATEGORIES: autoApproveCategoriesSchema,
});

export type Env = z.infer<typeof envSchema>;
