import {
  CreateSenderRuleSchema,
  PUBLIC_SUFFIX_DENYLIST,
  SenderRuleMatchType,
  SenderRuleSuggestionFamily,
  senderGlobToRegExp,
  senderRulePatternError,
} from "@email-ai/shared";
import { MatchableSenderRule, compileRules } from "./sender-rule-matcher";
import { isProtectedDomain, protectedProbeHosts } from "./protected-senders";

/**
 * Pure rule suggestions from classification history. No I/O: the service
 * aggregates per-domain counts and hands them in; nothing here writes a
 * rule. Every proposed rule passes CreateSenderRuleSchema.
 */

/** Classified-mail counts for one sender domain. */
export interface DomainClassificationStats {
  domain: string;
  /** Mail from this domain classified by the chosen provider. */
  total: number;
  marketing: number;
  newsletter: number;
}

export interface SuggestionOptions {
  /** Smallest family total worth suggesting. */
  minEmails: number;
  /** Share of a domain's mail that must be marketing + newsletter. */
  minShare: number;
}

/** Shortest shared leading token that makes a `prefix` family. */
export const PREFIX_MIN_LENGTH = 5;

/**
 * Fewest distinct second-level labels that make a `prefix` family. Two
 * look-alikes are often coincidence (two brands named after one person);
 * the rotating promo families seen in practice have 9 to 31.
 */
export const PREFIX_MIN_MEMBERS = 3;

type ProposedRule = SenderRuleSuggestionFamily["proposedRules"][number];
type PromoCategory = ProposedRule["category"];

interface DomainStat {
  domain: string;
  total: number;
  marketing: number;
  newsletter: number;
  share: number;
}

interface DomainParts {
  /** Labels left of the second-level label (`news` in news.x.com). */
  sub: string[];
  /** Second-level label (`x` in news.x.com, `x` in x.co.uk). */
  sld: string;
  /** Public suffix, one or two labels (`com`, `co.uk`). */
  suffix: string;
}

function splitDomain(domain: string): DomainParts {
  const labels = domain.split(".");
  const lastTwo = labels.slice(-2).join(".");
  const suffixLen =
    labels.length >= 3 && PUBLIC_SUFFIX_DENYLIST.has(lastTwo) ? 2 : 1;
  const sldIndex = labels.length - suffixLen - 1;
  return {
    sub: labels.slice(0, sldIndex),
    sld: labels[sldIndex],
    suffix: labels.slice(sldIndex + 1).join("."),
  };
}

function longestCommonPrefix(values: string[]): string {
  let prefix = values[0] ?? "";
  for (const v of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < v.length && prefix[i] === v[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** The proposal, validated; null when CreateSenderRuleSchema rejects it. */
function propose(
  pattern: string,
  matchType: SenderRuleMatchType,
  category: PromoCategory,
): ProposedRule | null {
  const parsed = CreateSenderRuleSchema.safeParse({
    pattern,
    matchType,
    action: "classify",
    category,
  });
  if (!parsed.success) return null;
  return {
    pattern: parsed.data.pattern,
    matchType: parsed.data.matchType,
    action: "classify",
    category,
  };
}

interface Group {
  key: string;
  kind: SenderRuleSuggestionFamily["kind"];
  members: DomainStat[];
  /** Candidate globs, each with the members it is meant to cover. */
  globs: { pattern: string; members: DomainStat[] }[];
}

/** `x.co.uk` for `mail.x.co.uk`. */
function registrableDomain(domain: string): string {
  const { sld, suffix } = splitDomain(domain);
  return `${sld}.${suffix}`;
}

/**
 * Groups qualifying domains into look-alike families and proposes rules.
 *
 * Single senders are grouped by a simple registrable-domain heuristic (a
 * small public-suffix denylist, not the full PSL), so hosts under a shared
 * suffix such as `com.tr` or `blogspot.com` may land in one family. The
 * proposals are still exact `domain` rules per host.
 *
 * A domain qualifies when at least `minShare` of its classified mail is
 * marketing or newsletter, it is not a protected sender, and no enabled
 * `existingRules` entry already matches it. Families: `news.<x>.<tld>`
 * (two or more; a glob only from PREFIX_MIN_MEMBERS), then a shared leading token of at least
 * PREFIX_MIN_LENGTH characters on the second-level label (at least
 * PREFIX_MIN_MEMBERS distinct labels), then single senders: one
 * registrable domain with any of its qualifying subdomains. Families under
 * `minEmails` are dropped.
 *
 * Only two globs are ever proposed: `news.*.<tld>`, and `<token>*.<tld>`
 * for a prefix family's apex members (when they alone number
 * PREFIX_MIN_MEMBERS). Subdomain members (`mail.x.com`)
 * and single senders get one `domain` rule per hostname, never a suffix
 * or subdomain wildcard: other subdomains of the same domain may be
 * legitimate. A family glob is proposed only when it passes CreateSenderRuleSchema
 * and matches no protected sender (probed, including common subdomains)
 * and no observed domain below the share threshold. Otherwise its members
 * each get a `domain` rule, and the colliding senders are listed in
 * `excludedLegit`.
 */
export function suggestSenderRules(
  stats: readonly DomainClassificationStats[],
  options: SuggestionOptions,
  existingRules: readonly MatchableSenderRule[] = [],
): SenderRuleSuggestionFamily[] {
  // Merge case variants of the same domain.
  const byDomain = new Map<string, DomainStat>();
  for (const s of stats) {
    const domain = s.domain.trim().toLowerCase();
    if (!domain || domain === "unknown") continue;
    const entry = byDomain.get(domain) ?? {
      domain,
      total: 0,
      marketing: 0,
      newsletter: 0,
      share: 0,
    };
    entry.total += s.total;
    entry.marketing += s.marketing;
    entry.newsletter += s.newsletter;
    byDomain.set(domain, entry);
  }
  const observed = [...byDomain.values()].filter((d) => d.total > 0);
  for (const d of observed) d.share = (d.marketing + d.newsletter) / d.total;

  const covered = compileRules(existingRules);
  const qualifying = observed.filter(
    (d) =>
      d.share >= options.minShare &&
      !isProtectedDomain(d.domain) &&
      senderRulePatternError(d.domain, "domain") === null &&
      covered.match({ fromAddress: null, senderDomain: d.domain }) === null,
  );

  const groups: Group[] = [];
  const assigned = new Set<string>();

  // (b) news.<x>.<tld>
  const news = new Map<string, DomainStat[]>();
  for (const d of qualifying) {
    const { sub, suffix } = splitDomain(d.domain);
    if (sub.length === 1 && sub[0] === "news") {
      news.set(suffix, [...(news.get(suffix) ?? []), d]);
    }
  }
  for (const [suffix, members] of news) {
    if (members.length < 2) continue;
    const pattern = `news.*.${suffix}`;
    // news.*.<tld> matches every news.<anything>.<tld>: two members get
    // per-domain rules only. From PREFIX_MIN_MEMBERS on, the glob is still
    // subject to the same collision checks as any other glob below.
    groups.push({
      key: pattern,
      kind: "news-subdomain",
      members,
      globs:
        members.length >= PREFIX_MIN_MEMBERS ? [{ pattern, members }] : [],
    });
    for (const m of members) assigned.add(m.domain);
  }

  // (a) shared leading token on the second-level label
  const buckets = new Map<string, DomainStat[]>();
  for (const d of qualifying) {
    if (assigned.has(d.domain)) continue;
    const { sld, suffix } = splitDomain(d.domain);
    if (sld.length < PREFIX_MIN_LENGTH) continue;
    // Punycode labels share the "xn--" prefix by encoding, not by brand.
    if (sld.startsWith("xn--")) continue;
    const key = `${sld.slice(0, PREFIX_MIN_LENGTH)}|${suffix}`;
    buckets.set(key, [...(buckets.get(key) ?? []), d]);
  }
  for (const [bucketKey, members] of buckets) {
    const labels = [...new Set(members.map((m) => splitDomain(m.domain).sld))];
    if (labels.length < PREFIX_MIN_MEMBERS) continue;
    const suffix = bucketKey.slice(bucketKey.indexOf("|") + 1);
    const prefix = longestCommonPrefix(labels);
    // The glob covers apex members only, and only when they alone form a
    // family: one apex domain plus subdomains of it is one brand, not a
    // rotating look-alike set, and a glob would only widen it.
    const apex = members.filter((m) => splitDomain(m.domain).sub.length === 0);
    const apexLabels = apex.map((m) => splitDomain(m.domain).sld);
    const globs: Group["globs"] =
      new Set(apexLabels).size >= PREFIX_MIN_MEMBERS
        ? [{ pattern: `${longestCommonPrefix(apexLabels)}*.${suffix}`, members: apex }]
        : [];
    groups.push({ key: `${prefix}*.${suffix}`, kind: "prefix", members, globs });
    for (const m of members) assigned.add(m.domain);
  }

  // (c) everything else: one sender (registrable domain) per family
  const singles = new Map<string, DomainStat[]>();
  for (const d of qualifying) {
    if (assigned.has(d.domain)) continue;
    const key = registrableDomain(d.domain);
    singles.set(key, [...(singles.get(key) ?? []), d]);
  }
  for (const [key, members] of singles) {
    groups.push({ key, kind: "single", members, globs: [] });
  }

  const probeHosts = protectedProbeHosts();
  const families: SenderRuleSuggestionFamily[] = [];

  for (const group of groups) {
    const totalEmails = group.members.reduce((n, m) => n + m.total, 0);
    if (totalEmails < options.minEmails) continue;

    const marketing = group.members.reduce((n, m) => n + m.marketing, 0);
    const newsletter = group.members.reduce((n, m) => n + m.newsletter, 0);
    const category: PromoCategory =
      marketing >= newsletter ? "marketing" : "newsletter";

    const proposedRules: ProposedRule[] = [];
    const excludedLegit = new Set<string>();
    const needDomainRule = new Set(group.members.map((m) => m.domain));

    for (const glob of group.globs) {
      const re = senderGlobToRegExp(glob.pattern);
      const collisions = [
        ...probeHosts.filter((h) => re.test(h)),
        ...observed
          .filter(
            (d) =>
              re.test(d.domain) &&
              (isProtectedDomain(d.domain) || d.share < options.minShare),
          )
          .map((d) => d.domain),
      ];
      const rule = collisions.length
        ? null
        : propose(glob.pattern, "glob", category);
      if (rule) {
        proposedRules.push(rule);
        for (const m of glob.members) needDomainRule.delete(m.domain);
      } else {
        for (const c of collisions) excludedLegit.add(c);
      }
    }

    const domains = [...group.members].sort(
      (a, b) => b.total - a.total || a.domain.localeCompare(b.domain),
    );
    for (const m of domains) {
      if (!needDomainRule.has(m.domain)) continue;
      const rule = propose(m.domain, "domain", category);
      if (rule) proposedRules.push(rule);
    }

    families.push({
      key: group.key,
      kind: group.kind,
      totalEmails,
      domains: domains.map((m) => ({
        domain: m.domain,
        total: m.total,
        share: round(m.share),
      })),
      proposedRules,
      excludedLegit: [...excludedLegit].sort(),
    });
  }

  return families.sort(
    (a, b) => b.totalEmails - a.totalEmails || a.key.localeCompare(b.key),
  );
}
