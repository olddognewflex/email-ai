import { safeRegex } from "safe-regex2";
import { z } from "zod";
import { EmailCategorySchema } from "./classification.schemas";

/**
 * How a sender rule's `pattern` is matched against an email's sender.
 *
 * - `address`       exact from-address, case-insensitive
 * - `domain`        exact sender domain
 * - `domain_suffix` the domain or any subdomain of it (label boundary)
 * - `glob`          anchored; targets the full address when the pattern
 *                   contains "@", else the domain. In the domain part `*`/`?`
 *                   stay within one label; in the local part (before "@")
 *                   they also match dots.
 * - `regex`         case-insensitive, UNANCHORED (use ^…$); same target
 *                   selection as `glob`
 */
export const SenderRuleMatchTypeSchema = z.enum([
  "address",
  "domain",
  "domain_suffix",
  "glob",
  "regex",
]);

export type SenderRuleMatchType = z.infer<typeof SenderRuleMatchTypeSchema>;

/**
 * What a matching rule does. `classify` only writes the classification;
 * `trash` also marks the mail for move-to-Trash (the mailbox write path
 * ships separately and is off by default).
 */
export const SenderRuleActionSchema = z.enum(["classify", "trash"]);

export type SenderRuleAction = z.infer<typeof SenderRuleActionSchema>;

export const SenderRuleSourceSchema = z.enum(["manual", "suggestion", "tui"]);

export type SenderRuleSource = z.infer<typeof SenderRuleSourceSchema>;

export const SENDER_RULE_REGEX_MAX_LENGTH = 200;
export const SENDER_RULE_GLOB_MIN_LITERALS = 3;

/** Values are truncated to these lengths before any pattern test. */
export const SENDER_ADDRESS_MAX_LENGTH = 320;
export const SENDER_DOMAIN_MAX_LENGTH = 253;

/**
 * Canary senders: a glob or regex that matches any of these is too broad
 * to be a sender rule (it would swallow ordinary mail). A single provider
 * belongs in an `address`, `domain` or `domain_suffix` rule instead.
 */
export const SENDER_RULE_CANARY_DOMAINS: readonly string[] = [
  "gmail.com",
  "outlook.com",
  "yahoo.com",
  "icloud.com",
  "amazon.com",
  "github.com",
  "bbc.co.uk",
  "abc.net.au",
  "wikipedia.org",
];

/**
 * Local parts probed at each canary domain for address-targeted patterns,
 * so a local-part-only rule (`^noreply@`) is caught as too broad.
 */
export const SENDER_RULE_CANARY_LOCAL_PARTS: readonly string[] = [
  "a.b",
  "noreply",
  "no-reply",
  "info",
  "news",
  "newsletter",
  "support",
  "hello",
  "team",
  "marketing",
  "notifications",
];

/**
 * Public suffixes (a small denylist, not the full PSL). A `domain_suffix`
 * rule may not be one of these, and a glob whose literal domain content is
 * only one of these is rejected.
 */
export const PUBLIC_SUFFIX_DENYLIST: ReadonlySet<string> = new Set([
  "com", "net", "org", "io", "co", "us", "uk", "de", "fr", "nl", "eu", "ca",
  "au", "nz", "jp", "in", "br", "ru", "cn", "es", "it", "ch", "se", "no",
  "info", "biz", "me", "app", "dev", "ai", "xyz", "online", "site", "shop",
  "top", "email", "news", "gov", "edu", "mil", "int",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "co.in", "com.br",
  "com.cn", "com.mx", "co.za", "com.sg", "com.hk",
]);

export function truncateSenderValue(
  value: string,
  target: "address" | "domain",
): string {
  return value.slice(
    0,
    target === "address" ? SENDER_ADDRESS_MAX_LENGTH : SENDER_DOMAIN_MAX_LENGTH,
  );
}

/** glob and regex patterns target the full address iff they contain "@". */
export function senderPatternTarget(
  pattern: string,
  matchType: SenderRuleMatchType,
): "address" | "domain" {
  if (matchType === "address") return "address";
  if (matchType === "glob" || matchType === "regex") {
    return pattern.includes("@") ? "address" : "domain";
  }
  return "domain";
}

/**
 * Anchored, case-insensitive RegExp for a sender glob. Before "@" (local
 * part) `*` = `[^@]*` and `?` = `[^@]`, so `*@x.com` matches
 * `first.last@x.com`. After "@", or in a domain-only glob, they never cross
 * a label: `*` = `[^.@]*`, `?` = `[^.@]`, so `news.*.com` does not match
 * `news.a.b.com`.
 */
export function senderGlobToRegExp(glob: string): RegExp {
  const hasAt = glob.includes("@");
  let inLocalPart = hasAt;
  let source = "";
  for (const ch of glob) {
    if (ch === "@") {
      inLocalPart = false;
      source += "@";
    } else if (ch === "*") {
      source += inLocalPart ? "[^@]*" : "[^.@]*";
    } else if (ch === "?") {
      source += inLocalPart ? "[^@]" : "[^.@]";
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "i");
}

/**
 * Lowercases a regex pattern without changing its meaning: the character
 * after a backslash is kept as written (`\S`, `\D`, `\W`, `\B` differ from
 * their lowercase forms), and so is everything inside `[...]`. Matching is case-insensitive anyway; this makes
 * `Backer` and `backer` the same stored rule.
 */
export function lowercaseRegexPattern(pattern: string): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      out += ch + pattern[i + 1];
      i++;
    } else if (inClass) {
      // Character classes are kept exactly as written: `[A-z]` is not
      // `[a-z]`.
      out += ch;
      if (ch === "]") inClass = false;
    } else {
      if (ch === "[") inClass = true;
      out += ch.toLowerCase();
    }
  }
  return out;
}

/** The stored form of a pattern: trimmed by Zod, then lowercased. */
export function normalizeSenderPattern(
  pattern: string,
  matchType: SenderRuleMatchType,
): string {
  return matchType === "regex"
    ? lowercaseRegexPattern(pattern)
    : pattern.toLowerCase();
}

/**
 * Conservative structural check on top of safe-regex2 (which misses
 * ambiguous alternation such as `(a|a)*`): rejects any group repeated by
 * `*`, `+` or `{n,…}` that itself contains a quantifier or an alternation.
 */
function hasRepeatedAmbiguousGroup(pattern: string): boolean {
  // Repeated at position i: *, + or {n,} / {n,m} with m > 1.
  const isRepeat = (i: number): boolean => {
    const c = pattern[i];
    if (c === "*" || c === "+") return true;
    const brace = /^\{(\d*)(,?)(\d*)\}/.exec(pattern.slice(i));
    if (!brace) return false;
    const [, min, comma, max] = brace;
    const upper = comma ? (max === "" ? Infinity : Number(max)) : Number(min);
    return upper > 1;
  };
  const stack: { risky: boolean }[] = [];
  const markParent = () => {
    if (stack.length) stack[stack.length - 1].risky = true;
  };
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++; // escaped character is a literal
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    switch (ch) {
      case "[":
        inClass = true;
        break;
      case "(": {
        stack.push({ risky: false });
        // Skip a group prefix: (?: (?= (?! (?<= (?<! (?<name>
        if (pattern[i + 1] === "?") {
          const rest = pattern.slice(i + 2);
          const named = /^<(?![=!])[^>]*>/.exec(rest);
          i += 1 + (named ? named[0].length : rest.startsWith("<") ? 2 : 1);
        }
        break;
      }
      case ")": {
        const group = stack.pop();
        const repeated = isRepeat(i + 1);
        if (group?.risky && repeated) return true;
        // A quantified or risky group makes its enclosing group risky.
        if (group?.risky || repeated || pattern[i + 1] === "?") markParent();
        break;
      }
      case "|":
      case "*":
      case "+":
      case "?":
      case "{":
        markParent();
        break;
    }
  }
  return false;
}

/** Most unbounded quantifiers (`*`, `+`, `{n,}`) a regex rule may use. */
export const SENDER_RULE_REGEX_MAX_UNBOUNDED = 3;

/**
 * Unbounded quantifiers outside character classes and escapes. Several in
 * sequence (`[a-z]*[a-z]*[a-z]*…`) backtrack polynomially even when
 * safe-regex2 accepts the pattern.
 */
export function countUnboundedQuantifiers(pattern: string): number {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "*" || ch === "+") count++;
    else if (ch === "{" && /^\{\d+,\}/.test(pattern.slice(i))) count++;
  }
  return count;
}

/** True when a regex is safe to run on untrusted sender strings. */
export function isSafeSenderRegex(pattern: string): boolean {
  if (pattern.length > SENDER_RULE_REGEX_MAX_LENGTH) return false;
  try {
    new RegExp(pattern, "i");
  } catch {
    return false;
  }
  return (
    safeRegex(pattern) &&
    !hasRepeatedAmbiguousGroup(pattern) &&
    countUnboundedQuantifiers(pattern) <= SENDER_RULE_REGEX_MAX_UNBOUNDED
  );
}

/**
 * Canary senders a glob or regex would match (see
 * SENDER_RULE_CANARY_DOMAINS). Expects a pattern that already passed the
 * per-type checks, so a regex here is known to compile and be safe.
 */
export function senderRuleCanaryHits(
  pattern: string,
  matchType: "glob" | "regex",
): string[] {
  const re =
    matchType === "glob"
      ? senderGlobToRegExp(pattern)
      : new RegExp(pattern, "i");
  const target = senderPatternTarget(pattern, matchType);
  const values =
    target === "address"
      ? SENDER_RULE_CANARY_DOMAINS.flatMap((d) =>
          SENDER_RULE_CANARY_LOCAL_PARTS.map((local) => `${local}@${d}`),
        )
      : SENDER_RULE_CANARY_DOMAINS;
  return values.filter((value) => re.test(value));
}

/**
 * The literal part of a glob's domain: labels left once wildcard-only
 * labels are dropped (`*.co.uk` → `co.uk`, `*@*.com` → `com`).
 */
function globLiteralDomain(glob: string): string {
  const domain = glob.slice(glob.indexOf("@") + 1);
  return domain
    .split(".")
    .filter((label) => /[a-z0-9]/.test(label))
    .join(".");
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GLOB_CHARSET = /^[a-z0-9.*?@_+-]+$/;
const TOO_BROAD_GLOBS = new Set(["*", "*.*", "*@*"]);

/** A hostname with at least two labels and no wildcards. */
function isValidHostname(value: string): boolean {
  if (value.length > 253) return false;
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((l) => HOSTNAME_LABEL.test(l));
}

/**
 * Returns a human-readable reason when `pattern` is not valid for
 * `matchType`, or null when it is. Expects the stored form of the pattern
 * (trimmed; lowercased unless regex).
 */
export function senderRulePatternError(
  pattern: string,
  matchType: SenderRuleMatchType,
): string | null {
  switch (matchType) {
    case "regex": {
      if (pattern.length > SENDER_RULE_REGEX_MAX_LENGTH) {
        return `regex must be at most ${SENDER_RULE_REGEX_MAX_LENGTH} characters`;
      }
      try {
        new RegExp(pattern, "i");
      } catch (error) {
        return `regex does not compile: ${(error as Error).message}`;
      }
      if (!isSafeSenderRegex(pattern)) {
        if (countUnboundedQuantifiers(pattern) > SENDER_RULE_REGEX_MAX_UNBOUNDED) {
          return `regex is unsafe: more than ${SENDER_RULE_REGEX_MAX_UNBOUNDED} unbounded quantifiers (*, +, {n,}) can backtrack heavily on a crafted sender; simplify it or split it into several rules`;
        }
        return (
          "regex is unsafe: nested, optional or ambiguous repetition (e.g. (a+)+, (a|b)*, (x+)?) " +
          "can hang on a crafted sender. Split it into two simpler rules, or use glob rules " +
          "such as kickstar*.com plus *.kickstar*.com"
        );
      }
      return tooBroadError(pattern, "regex");
    }
    case "address":
      return z.string().email().safeParse(pattern).success
        ? null
        : "address must be a valid email address";
    case "domain":
      return isValidHostname(pattern)
        ? null
        : "domain must be a hostname like example.com (no wildcards)";
    case "domain_suffix":
      if (!isValidHostname(pattern)) {
        return "domain_suffix must be a hostname like example.com (no wildcards)";
      }
      return PUBLIC_SUFFIX_DENYLIST.has(pattern)
        ? `domain_suffix "${pattern}" is a public suffix and would match nearly all mail`
        : null;
    case "glob": {
      if (!GLOB_CHARSET.test(pattern)) {
        return "glob may only contain a-z 0-9 . * ? @ _ + -";
      }
      if (TOO_BROAD_GLOBS.has(pattern)) {
        return `glob "${pattern}" is too broad`;
      }
      if ((pattern.match(/@/g) ?? []).length > 1) {
        return "glob may contain at most one @";
      }
      const literals = (pattern.match(/[a-z0-9]/g) ?? []).length;
      if (literals < SENDER_RULE_GLOB_MIN_LITERALS) {
        return `glob is too broad: needs at least ${SENDER_RULE_GLOB_MIN_LITERALS} literal letters or digits`;
      }
      const literalDomain = globLiteralDomain(pattern);
      if (literalDomain === "" || PUBLIC_SUFFIX_DENYLIST.has(literalDomain)) {
        return `glob is too broad: its domain is only a public suffix ("${literalDomain}")`;
      }
      return tooBroadError(pattern, "glob");
    }
  }
}

function tooBroadError(
  pattern: string,
  matchType: "glob" | "regex",
): string | null {
  const hits = senderRuleCanaryHits(pattern, matchType);
  return hits.length
    ? `${matchType} is too broad: it matches ordinary senders (${hits.join(", ")}); use an address, domain or domain_suffix rule for a single provider`
    : null;
}

/**
 * The fields of a sender rule, without cross-field validation. Used as
 * the base for both create (validated) and update (partial) payloads.
 */
const SenderRuleFieldsSchema = z.object({
  pattern: z.string().trim().min(1).max(320),
  matchType: SenderRuleMatchTypeSchema,
  action: SenderRuleActionSchema.default("classify"),
  category: EmailCategorySchema.optional(),
  enabled: z.boolean().default(true),
  note: z.string().max(500).nullable().optional(),
  source: SenderRuleSourceSchema.optional(),
});

/**
 * Create payload. Normalizes `pattern` (lowercased; for regex, escape
 * sequences are kept as written),
 * validates it per `matchType`, requires `category` for `classify` rules
 * and defaults it to `delete` for `trash` rules.
 */
export const CreateSenderRuleSchema = SenderRuleFieldsSchema.transform(
  (value) => ({
    ...value,
    pattern: normalizeSenderPattern(value.pattern, value.matchType),
  }),
)
  .superRefine((value, ctx) => {
    const patternError = senderRulePatternError(value.pattern, value.matchType);
    if (patternError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pattern"],
        message: patternError,
      });
    }
    if (value.action === "classify" && !value.category) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["category"],
        message: "category is required for classify rules",
      });
    }
  })
  .transform((value) => ({
    ...value,
    category: value.category ?? ("delete" as const),
  }));

export type CreateSenderRuleInput = z.input<typeof CreateSenderRuleSchema>;
export type CreateSenderRule = z.output<typeof CreateSenderRuleSchema>;

/**
 * Update payload: any subset of the fields. The service merges it with
 * the stored rule and re-validates the result with CreateSenderRuleSchema,
 * so e.g. changing `matchType` re-checks the existing `pattern`.
 */
export const UpdateSenderRuleSchema = SenderRuleFieldsSchema.partial();

export type UpdateSenderRule = z.infer<typeof UpdateSenderRuleSchema>;

/** Dry look at what a pattern would match in stored mail. */
export const SenderRulePreviewRequestSchema = z
  .object({
    pattern: z.string().trim().min(1).max(320),
    matchType: SenderRuleMatchTypeSchema,
  })
  .transform((value) => ({
    ...value,
    pattern: normalizeSenderPattern(value.pattern, value.matchType),
  }))
  .superRefine((value, ctx) => {
    const patternError = senderRulePatternError(value.pattern, value.matchType);
    if (patternError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pattern"],
        message: patternError,
      });
    }
  });

export type SenderRulePreviewRequest = z.output<
  typeof SenderRulePreviewRequestSchema
>;

/** A stored sender rule as returned by the API. */
export const SenderRuleSchema = z.object({
  id: z.string(),
  pattern: z.string(),
  matchType: SenderRuleMatchTypeSchema,
  action: SenderRuleActionSchema,
  category: EmailCategorySchema,
  enabled: z.boolean(),
  note: z.string().nullable(),
  source: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type SenderRule = z.infer<typeof SenderRuleSchema>;
