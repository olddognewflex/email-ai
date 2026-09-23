import { extractMessageId, normalizeMessageId, sameMessageId } from './message-id';

const raw = (headers: string) => Buffer.from(`${headers}\r\n\r\nbody Message-ID: <body@x>`);

describe('extractMessageId', () => {
  it('reads the header, case-insensitively, without brackets', () => {
    expect(extractMessageId(raw('From: a@b\r\nmessage-id:  <Abc.123@Mail.Example>\r\nSubject: x'))).toBe(
      'Abc.123@Mail.Example',
    );
  });

  it('unfolds a folded header', () => {
    expect(extractMessageId(raw('Message-ID:\r\n <folded@x.example>'))).toBe('folded@x.example');
  });

  it('ignores the body', () => {
    expect(extractMessageId(raw('Subject: none'))).toBeNull();
  });

  it('returns null for duplicate or empty headers', () => {
    expect(extractMessageId(raw('Message-ID: <a@x>\r\nMessage-ID: <b@x>'))).toBeNull();
    expect(extractMessageId(raw('Message-ID:   '))).toBeNull();
    expect(extractMessageId(null)).toBeNull();
    expect(extractMessageId(Buffer.alloc(0))).toBeNull();
  });

  it('handles LF-only messages', () => {
    expect(extractMessageId(Buffer.from('Message-ID: <lf@x>\n\nbody'))).toBe('lf@x');
  });
});

describe('normalizeMessageId / sameMessageId', () => {
  it('strips brackets and whitespace, keeps case', () => {
    expect(normalizeMessageId(' <Id@X> ')).toBe('Id@X');
    expect(normalizeMessageId('id@x')).toBe('id@x');
    expect(normalizeMessageId('has space@x')).toBeNull();
  });

  it('compares normalized values and never matches unknowns', () => {
    expect(sameMessageId('<a@x>', 'a@x')).toBe(true);
    expect(sameMessageId('A@x', 'a@x')).toBe(false);
    expect(sameMessageId(null, null)).toBe(false);
    expect(sameMessageId(undefined, 'a@x')).toBe(false);
  });
});
