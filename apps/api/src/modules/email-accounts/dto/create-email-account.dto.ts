import { z } from 'zod';

export const CreateEmailAccountSchema = z.object({
  label: z.string().min(1).max(100),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(993),
  username: z.string().min(1),
  password: z.string().min(1),
  secure: z.boolean().default(true),
});

export type CreateEmailAccountDto = z.infer<typeof CreateEmailAccountSchema>;
