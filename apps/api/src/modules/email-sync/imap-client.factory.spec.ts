import { ImapFlow } from 'imapflow';
import { createImapClient } from './imap-client.factory';

jest.mock('imapflow', () => ({ ImapFlow: jest.fn() }));

const ImapFlowMock = ImapFlow as unknown as jest.Mock;
const account = { host: 'imap.example.com', port: 993, secure: true, username: 'me@example.com' };

describe('createImapClient', () => {
  afterEach(() => ImapFlowMock.mockReset());

  it('builds a password client without connecting', () => {
    createImapClient(account, { kind: 'password', password: 'pw' });
    expect(ImapFlowMock).toHaveBeenCalledWith({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      auth: { user: 'me@example.com', pass: 'pw' },
      logger: false,
    });
  });

  it('builds an XOAUTH2 client', () => {
    createImapClient(account, { kind: 'oauth', accessToken: 'tok' });
    expect(ImapFlowMock.mock.calls[0][0].auth).toEqual({
      user: 'me@example.com',
      accessToken: 'tok',
    });
  });
});
