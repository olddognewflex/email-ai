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
