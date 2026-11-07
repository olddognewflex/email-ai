import { envSchema } from './env.schema';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  ENCRYPTION_KEY: 'k',
};

describe('envSchema MAILBOX_WRITES_ENABLED', () => {
  it('is false when unset', () => {
    expect(envSchema.parse(base).MAILBOX_WRITES_ENABLED).toBe(false);
  });

  it.each(['false', '1', 'yes', 'TRUE', 'True', ' true', 'true ', '', 'on', '0'])(
    '%p is false (fail closed)',
    (value) => {
      expect(envSchema.parse({ ...base, MAILBOX_WRITES_ENABLED: value }).MAILBOX_WRITES_ENABLED).toBe(
        false,
      );
    },
  );

  it('only the exact string "true" enables writes', () => {
    expect(envSchema.parse({ ...base, MAILBOX_WRITES_ENABLED: 'true' }).MAILBOX_WRITES_ENABLED).toBe(
      true,
    );
  });
});

describe('envSchema AUTO_APPROVE_ENABLED', () => {
  it('is false when unset', () => {
    expect(envSchema.parse(base).AUTO_APPROVE_ENABLED).toBe(false);
  });

  it.each(['false', '1', 'yes', 'TRUE', ' true', ''])('%p is false', (value) => {
    expect(envSchema.parse({ ...base, AUTO_APPROVE_ENABLED: value }).AUTO_APPROVE_ENABLED).toBe(false);
  });

  it('only the exact string "true" enables it', () => {
    expect(envSchema.parse({ ...base, AUTO_APPROVE_ENABLED: 'true' }).AUTO_APPROVE_ENABLED).toBe(true);
  });
});

describe('envSchema AUTO_APPROVE_CATEGORIES', () => {
  it('defaults to newsletter, marketing, archive, receipt', () => {
    expect(envSchema.parse(base).AUTO_APPROVE_CATEGORIES).toEqual([
      'newsletter',
      'marketing',
      'archive',
      'receipt',
    ]);
  });

  it('parses a comma-separated list, trimming and de-duplicating', () => {
    expect(
      envSchema.parse({ ...base, AUTO_APPROVE_CATEGORIES: ' notification, social ,notification' })
        .AUTO_APPROVE_CATEGORIES,
    ).toEqual(['notification', 'social']);
  });

  it.each(['', '   ', ','])('blank %p falls back to the default list', (value) => {
    expect(envSchema.parse({ ...base, AUTO_APPROVE_CATEGORIES: value }).AUTO_APPROVE_CATEGORIES)
      .toEqual(['newsletter', 'marketing', 'archive', 'receipt']);
  });

  it('ignores empty entries from stray commas', () => {
    expect(
      envSchema.parse({ ...base, AUTO_APPROVE_CATEGORIES: 'newsletter,,marketing,' })
        .AUTO_APPROVE_CATEGORIES,
    ).toEqual(['newsletter', 'marketing']);
  });

  it.each(['newsletter,bogus', 'Newsletter', 'newsletter,typo,'])(
    'rejects invalid entries: %p',
    (value) => {
      expect(() => envSchema.parse({ ...base, AUTO_APPROVE_CATEGORIES: value })).toThrow();
    },
  );

  it.each(['unknown', 'newsletter,unknown'])('never allows unknown: %p', (value) => {
    expect(() => envSchema.parse({ ...base, AUTO_APPROVE_CATEGORIES: value })).toThrow();
  });
});
