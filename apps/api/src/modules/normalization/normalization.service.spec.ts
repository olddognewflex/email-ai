import { buildTags, extractSenderDomain, isBulkSender } from './normalization.service';

describe('extractSenderDomain', () => {
  it('extracts the domain from a valid email address', () => {
    expect(extractSenderDomain('user@example.com')).toBe('example.com');
  });

  it('lowercases the domain', () => {
    expect(extractSenderDomain('user@EXAMPLE.COM')).toBe('example.com');
  });

  it('returns unknown for null', () => {
    expect(extractSenderDomain(null)).toBe('unknown');
  });

  it('returns unknown when there is no @ sign', () => {
    expect(extractSenderDomain('notanemail')).toBe('unknown');
  });
});

describe('isBulkSender', () => {
  it('detects noreply addresses', () => {
    expect(isBulkSender('noreply@example.com')).toBe(true);
  });

  it('detects no-reply addresses', () => {
    expect(isBulkSender('no-reply@example.com')).toBe(true);
  });

  it('returns false for a normal sender', () => {
    expect(isBulkSender('alice@example.com')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isBulkSender(null)).toBe(false);
  });
});

describe('buildTags', () => {
  it('adds newsletter tag when hasUnsubscribe is true', () => {
    expect(buildTags(true, false, 0)).toContain('newsletter');
  });

  it('adds bulk tag when isBulk is true', () => {
    expect(buildTags(false, true, 0)).toContain('bulk');
  });

  it('adds has-attachments tag when count > 0', () => {
    expect(buildTags(false, false, 2)).toContain('has-attachments');
  });

  it('returns empty array for a plain non-bulk email', () => {
    expect(buildTags(false, false, 0)).toEqual([]);
  });

  it('can combine multiple tags', () => {
    const tags = buildTags(true, true, 1);
    expect(tags).toContain('newsletter');
    expect(tags).toContain('bulk');
    expect(tags).toContain('has-attachments');
  });
});
