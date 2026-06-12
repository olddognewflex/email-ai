import { z } from 'zod';

export const StartGoogleOAuthSchema = z.object({
  label: z.string().min(1).max(100).default('Gmail'),
  accountId: z.string().cuid().optional(),
});

export type StartGoogleOAuthDto = z.infer<typeof StartGoogleOAuthSchema>;

export const GoogleOAuthCallbackSchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().optional(),
});

export type GoogleOAuthCallbackDto = z.infer<typeof GoogleOAuthCallbackSchema>;
