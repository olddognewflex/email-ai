export interface MailClientConfig {
  host: string;
  port: number;
  username: string;
  /** Password for plain LOGIN auth. Either this or accessToken is required. */
  password?: string;
  /** OAuth2 access token for XOAUTH2 auth. Takes precedence over password. */
  accessToken?: string;
  secure?: boolean;
}

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailMessage {
  uid: number;
  messageId?: string;
  subject?: string;
  from: EmailAddress;
  date?: Date;
  body: string;
  isHtml: boolean;
  flags: string[];
  internalDate: Date;
}

export interface FetchOptions {
  /** Mailbox to fetch from (default: 'INBOX') */
  mailbox?: string;
  /** Maximum number of messages to fetch (default: 50) */
  limit?: number;
  /** Fetch messages with UID greater than this value */
  sinceUid?: number;
  /** Fetch most recent messages first (default: true) */
  newestFirst?: boolean;
}

export interface FetchResult {
  messages: EmailMessage[];
  /** Highest UID fetched */
  lastUid: number;
  /** Total messages in mailbox */
  totalMessages: number;
}
