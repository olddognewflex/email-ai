import { EmailAccount } from '@prisma/client';
import { ImapFlow } from 'imapflow';
import { ImapCredentials } from '../email-accounts/email-accounts.service';

/** The account fields needed to open an IMAP connection. */
export type ImapAccount = Pick<EmailAccount, 'host' | 'port' | 'secure' | 'username'>;

/**
 * Builds an unconnected ImapFlow client for an account. The single place
 * that constructs ImapFlow for RawEmail sync and for mailbox writes, so
 * tests can inject a fake through IMAP_CLIENT_FACTORY.
 */
export function createImapClient(
  account: ImapAccount,
  credentials: ImapCredentials,
): ImapFlow {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth:
      credentials.kind === 'oauth'
        ? { user: account.username, accessToken: credentials.accessToken }
        : { user: account.username, pass: credentials.password },
    logger: false,
  });
}

export type ImapClientFactory = typeof createImapClient;

/** DI token for the ImapClientFactory. */
export const IMAP_CLIENT_FACTORY = Symbol('IMAP_CLIENT_FACTORY');

export const imapClientFactoryProvider = {
  provide: IMAP_CLIENT_FACTORY,
  useValue: createImapClient,
};
