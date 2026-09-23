/**
 * Message-ID helpers for verifying a stored UID still names the same
 * message before a mailbox write. Pure: no I/O.
 */

/** Only the header block is scanned, and at most this many bytes of it. */
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_MESSAGE_ID_LENGTH = 998;

/**
 * Canonical form for comparison: trimmed, angle brackets removed. Returns
 * null for an empty or implausible value. Case is preserved (the local
 * part of a Message-ID is case-sensitive).
 */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim();
  const open = v.indexOf('<');
  const close = v.indexOf('>', open + 1);
  if (open !== -1 && close !== -1) v = v.slice(open + 1, close);
  // A stray unmatched bracket must not make two equal ids differ.
  v = v.replace(/^</, '').replace(/>$/, '').trim();
  if (!v || v.length > MAX_MESSAGE_ID_LENGTH || /\s/.test(v)) return null;
  return v;
}

/**
 * Message-ID header of an RFC 5322 message, from its raw source, in
 * normalized form (see normalizeMessageId). Null when absent, duplicated
 * (ambiguous), or malformed.
 */
export function extractMessageId(rawSource: Uint8Array | null | undefined): string | null {
  if (!rawSource || rawSource.length === 0) return null;
  const head = Buffer.from(
    rawSource.buffer,
    rawSource.byteOffset,
    Math.min(rawSource.length, MAX_HEADER_BYTES),
  ).toString('latin1');

  const end = head.search(/\r?\n\r?\n/);
  const block = end === -1 ? head : head.slice(0, end);
  // Unfold continuation lines (RFC 5322 section 2.2.3).
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');

  const values: string[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const m = /^message-id[ \t]*:(.*)$/i.exec(line);
    if (m) values.push(m[1]);
  }
  if (values.length !== 1) return null;
  return normalizeMessageId(values[0]);
}

/** True when both are known and equal after normalization. */
export function sameMessageId(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const x = normalizeMessageId(a);
  const y = normalizeMessageId(b);
  return x !== null && x === y;
}
