import {
  SenderRuleMatchType,
  isSafeSenderRegex,
  senderGlobToRegExp,
  senderPatternTarget,
  truncateSenderValue,
} from "@email-ai/shared";

/**
 * Pure sender-rule matching. No I/O: the service loads rules and hands
 * them to `compileRules`; the classify step calls `match` per email.
 */

/** The subset of a stored SenderRule the matcher needs. */
export interface MatchableSenderRule {
  id: string;
  pattern: string;
  matchType: SenderRuleMatchType;
  category: string;
  action: string;
  createdAt: Date;
  enabled?: boolean;
}

export interface SenderIdentity {
  fromAddress: string | null;
  senderDomain: string | null;
}

export type MatchedOn = "address" | "domain";

export interface SenderRuleMatch<R extends MatchableSenderRule> {
  rule: R;
  matchedOn: MatchedOn;
}

export interface SenderRuleMatcher<R extends MatchableSenderRule> {
  /** Number of compiled (enabled, valid) rules. */
  readonly size: number;
  /**
   * Ids of enabled rules left out because their regex does not compile or
   * is unsafe. Validation prevents these on write; callers should log them.
   */
  readonly skipped: readonly string[];
  match(sender: SenderIdentity): SenderRuleMatch<R> | null;
}

/** Lower rank wins. */
export const MATCH_TYPE_RANK: Record<SenderRuleMatchType, number> = {
  address: 0,
  domain: 1,
  domain_suffix: 2,
  glob: 3,
  regex: 4,
};

interface CompiledRule<R extends MatchableSenderRule> {
  rule: R;
  target: MatchedOn;
  test: (value: string) => boolean;
}

/** Re-exported for callers of the matcher; defined in @email-ai/shared. */
export const globToRegExp = senderGlobToRegExp;

function compileOne<R extends MatchableSenderRule>(
  rule: R,
): CompiledRule<R> | null {
  const pattern = rule.pattern;
  switch (rule.matchType) {
    case "address": {
      const p = pattern.toLowerCase();
      return { rule, target: "address", test: (a) => a === p };
    }
    case "domain": {
      const p = pattern.toLowerCase();
      return { rule, target: "domain", test: (d) => d === p };
    }
    case "domain_suffix": {
      const p = pattern.toLowerCase();
      return {
        rule,
        target: "domain",
        test: (d) => d === p || d.endsWith(`.${p}`),
      };
    }
    case "glob": {
      const re = senderGlobToRegExp(pattern.toLowerCase());
      return {
        rule,
        target: senderPatternTarget(pattern, "glob"),
        test: (v) => re.test(v),
      };
    }
    case "regex": {
      // Validation rejects these on write; a stored row that does not
      // compile, or could backtrack catastrophically on a crafted From
      // header, is skipped rather than run synchronously per email.
      if (!isSafeSenderRegex(pattern)) return null;
      const re = new RegExp(pattern, "i");
      return {
        rule,
        target: senderPatternTarget(pattern, "regex"),
        test: (v) => re.test(v),
      };
    }
    default:
      return null;
  }
}

/**
 * Deterministic precedence: match type rank (address > domain >
 * domain_suffix > glob > regex), then longer pattern, then older rule,
 * then id. Independent of input order.
 */
export function compareRulePrecedence(
  a: MatchableSenderRule,
  b: MatchableSenderRule,
): number {
  return (
    MATCH_TYPE_RANK[a.matchType] - MATCH_TYPE_RANK[b.matchType] ||
    b.pattern.length - a.pattern.length ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function compileRules<R extends MatchableSenderRule>(
  rules: readonly R[],
): SenderRuleMatcher<R> {
  const compiled: CompiledRule<R>[] = [];
  const skipped: string[] = [];
  for (const r of rules
    .filter((rule) => rule.enabled !== false)
    .slice()
    .sort(compareRulePrecedence)) {
    const c = compileOne(r);
    if (c) compiled.push(c);
    else skipped.push(r.id);
  }

  return {
    size: compiled.length,
    skipped,
    match({ fromAddress, senderDomain }) {
      // Bound the input before any pattern runs on it (From headers are
      // attacker-controlled).
      const address = fromAddress
        ? truncateSenderValue(fromAddress.trim().toLowerCase(), "address")
        : null;
      const domain = senderDomain
        ? truncateSenderValue(senderDomain.trim().toLowerCase(), "domain")
        : null;
      const usableDomain = domain && domain !== "unknown" ? domain : null;

      for (const c of compiled) {
        const value = c.target === "address" ? address : usableDomain;
        if (value && c.test(value)) {
          return { rule: c.rule, matchedOn: c.target };
        }
      }
      return null;
    },
  };
}
