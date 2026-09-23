import {
  SenderRuleMatchType,
  normalizeSenderPattern,
  truncateSenderValue,
} from "@email-ai/shared";
import { compileRules } from "./sender-rule-matcher";

/**
 * Legitimate senders that look like the promo families sender rules are
 * built to catch. Suffix semantics: each entry also covers its subdomains
 * (`me.kickstarter.com`, `x.backerkit.com`).
 *
 * User-created rules that would hit one of these are allowed but get a
 * warning (warn only, by decision). Suggestions must never propose them.
 */
export const PROTECTED_SENDER_DOMAINS: readonly string[] = [
  "kickstarter.com",
  "backerkit.com",
  "pledgebox.com",
  "songkick.com",
];

/** Subdomain labels probed when a pattern cannot be checked structurally. */
const PROBE_SUBDOMAINS = ["", "www.", "me.", "mail.", "email.", "news.", "x."];
const PROBE_LOCAL_PARTS = ["news", "team", "info", "noreply"];

/**
 * Protected hostnames probed for domain-targeted patterns: each protected
 * domain and a handful of common subdomains of it (`news.kickstarter.com`).
 */
export function protectedProbeHosts(): string[] {
  return PROTECTED_SENDER_DOMAINS.flatMap((d) =>
    PROBE_SUBDOMAINS.map((sub) => `${sub}${d}`),
  );
}

/** True when `domain` is a protected domain or a subdomain of one. */
export function isProtectedDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  return PROTECTED_SENDER_DOMAINS.some((p) => d === p || d.endsWith(`.${p}`));
}

/**
 * Protected domains a rule with this pattern would match. Exact types are
 * checked structurally; glob and regex are probed against the protected
 * domain, a handful of common subdomains, and common local parts. Probing
 * cannot prove a pattern safe, so treat an empty result as "no known hit".
 * Probes run through the matcher, which truncates values and skips
 * unsafe regexes, so this is safe on any input.
 */
export function protectedHits(
  pattern: string,
  matchType: SenderRuleMatchType,
): string[] {
  const p = normalizeSenderPattern(pattern.trim(), matchType);

  if (matchType === "address" || matchType === "domain") {
    const host = truncateSenderValue(
      matchType === "address" ? p.slice(p.indexOf("@") + 1) : p,
      "domain",
    );
    return PROTECTED_SENDER_DOMAINS.filter(
      (d) => host === d || host.endsWith(`.${d}`),
    );
  }

  if (matchType === "domain_suffix") {
    // Hit when the suffix covers a protected domain (p = "com" style is
    // rejected by validation) or lies inside one.
    return PROTECTED_SENDER_DOMAINS.filter(
      (d) => d === p || d.endsWith(`.${p}`) || p.endsWith(`.${d}`),
    );
  }

  const matcher = compileRules([
    {
      id: "probe",
      pattern: p,
      matchType,
      category: "unknown",
      action: "classify",
      createdAt: new Date(0),
    },
  ]);
  return PROTECTED_SENDER_DOMAINS.filter((d) =>
    PROBE_SUBDOMAINS.some((sub) => {
      const host = `${sub}${d}`;
      return PROBE_LOCAL_PARTS.some(
        (local) =>
          matcher.match({ fromAddress: `${local}@${host}`, senderDomain: host }) !==
          null,
      );
    }),
  );
}

export function protectedHitWarnings(
  pattern: string,
  matchType: SenderRuleMatchType,
): string[] {
  return protectedHits(pattern, matchType).map(
    (d) =>
      `Pattern would match protected sender domain ${d} (legitimate look-alike); rule saved anyway`,
  );
}
