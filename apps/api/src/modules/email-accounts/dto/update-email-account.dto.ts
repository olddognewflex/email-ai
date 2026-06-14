import { z } from 'zod';

export const UpdateEmailAccountSchema = z.object({
  label: z.string().min(1).max(100),
});

export type UpdateEmailAccountDto = z.infer<typeof UpdateEmailAccountSchema>;
