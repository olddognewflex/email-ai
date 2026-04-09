import { SyncResultData } from '@email-ai/shared';

export interface SyncOptions {
  mailbox: string;
  dryRun: boolean;
  batchSize?: number;
}

export type SyncResult = SyncResultData;

export const DEFAULT_MAILBOX = 'INBOX';
export const DEFAULT_BATCH_SIZE = 50;
