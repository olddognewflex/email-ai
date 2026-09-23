import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * Static guard over every apps/<name>/src and packages/<name>/src (.ts, .tsx):
 * no source file may contain a permanent-delete, flag, copy, append or
 * raw write-command primitive, and only the mailbox writer may reach
 * messageMove. This file is the one exclusion (it has to spell the
 * patterns out).
 */
const SRC_ROOT = join(__dirname, '..', '..');
const REPO_ROOT = join(SRC_ROOT, '..', '..', '..');
const SELF = __filename;

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'messageDelete', pattern: /messageDelete/ },
  { name: '\\Deleted flag', pattern: /\\+Deleted/ },
  { name: 'expunge(', pattern: /expunge\s*\(/i },
  { name: 'messageFlagsAdd', pattern: /messageFlagsAdd/ },
  { name: 'messageFlagsSet', pattern: /messageFlagsSet/ },
  { name: 'messageFlagsRemove', pattern: /messageFlagsRemove/ },
  { name: 'messageCopy', pattern: /messageCopy/ },
  { name: 'mailboxDelete', pattern: /mailboxDelete/ },
  // Raw IMAP commands are upper case in code ("Store Deals" is not one).
  { name: 'raw EXPUNGE command', pattern: /['"`]\s*(UID\s+)?EXPUNGE\b/ },
  { name: 'raw STORE command', pattern: /['"`]\s*(UID\s+)?STORE\b/ },
  { name: 'mailboxRename', pattern: /mailboxRename/ },
  { name: 'append(', pattern: /\bappend\s*\(/ },
  {
    name: 'run(<write command>)',
    pattern: /\brun\(\s*['"`](MOVE|COPY|DELETE|RENAME|EXPUNGE|STORE)/,
  },
];

/** Any way of reaching messageMove, including bracket access. */
const MESSAGE_MOVE = /\.messageMove\s*\(|\[\s*['"`]messageMove['"`]\s*\]/;

const WRITER = join('modules', 'mailbox-actions', 'mailbox-writer.service.ts');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('static mailbox-safety guard', () => {
  // Every apps/*/src and packages/*/src (api, tui, mail-client, shared).
  const srcDirs = ['apps', 'packages'].flatMap((top) =>
    readdirSync(join(REPO_ROOT, top))
      .map((p) => join(REPO_ROOT, top, p, 'src'))
      .filter((d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      }),
  );
  const files = srcDirs.flatMap(tsFiles).filter((f) => f !== SELF);

  it('scans the real source tree', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((f) => relative(SRC_ROOT, f))).toContain(WRITER);
    expect(files.some((f) => f.includes(join('packages', 'mail-client', 'src')))).toBe(true);
    expect(files.some((f) => f.includes(join('apps', 'tui', 'src')))).toBe(true);
  });

  it.each(FORBIDDEN)('no source file contains $name', ({ pattern }) => {
    const offenders = files
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('only the mailbox writer calls messageMove (specs aside)', () => {
    const callers = files
      .filter((f) => !f.endsWith('.spec.ts'))
      .filter((f) => MESSAGE_MOVE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC_ROOT, f).split(sep).join('/'));
    expect(callers).toEqual([WRITER.split(sep).join('/')]);
  });

  it('reconcile and the shared lookups never touch messageMove or the writer', () => {
    for (const name of ['mailbox-reconcile.service.ts', 'imap-lookup.ts']) {
      const src = readFileSync(join(__dirname, name), 'utf8');
      expect(src).not.toMatch(/messageMove/);
      expect(src).not.toMatch(/MailboxWriterService|mailbox-writer/);
    }
  });
});
