import { CreateSenderRuleSchema, SenderRuleSuggestionFamily } from "@email-ai/shared";
import { compileRules } from "./sender-rule-matcher";
import {
  DomainClassificationStats,
  suggestSenderRules,
} from "./sender-rule-suggestions";

const promo = (
  domain: string,
  total: number,
  marketing = total,
  newsletter = 0,
): DomainClassificationStats => ({ domain, total, marketing, newsletter });

/** 18 kickstar* + 13 backer* gadget-promo domains = 31, all marketing. */
const KICKSTAR = [
  "kickstargo", "kickstarnow", "kickstarhub", "kickstardeals", "kickstartrends",
  "kickstarpicks", "kickstarzone", "kickstarbuzz", "kickstardaily", "kickstarlab",
  "kickstarfinds", "kickstarbox", "kickstarclub", "kickstarshop", "kickstarworld",
  "kickstargear", "kickstarpro", "kickstartech",
].map((n) => `${n}.com`);
const BACKER = [
  "backerdeals", "backerclub", "backerpledge", "backerhub", "backerzone",
  "backerpicks", "backerbuzz", "backerdaily", "backerfinds", "backerbox",
  "backergear", "backershop", "backerworld",
].map((n) => `${n}.com`);
/** news.<name>.com finance promos. */
const NEWS = [
  "getthefinnewsnow", "financialspiration", "marketpulsedaily",
  "wealthinsider", "stockwhisper", "cryptodigestnow",
].map((n) => `news.${n}.com`);

const STATS: DomainClassificationStats[] = [
  ...KICKSTAR.map((d, i) => promo(d, 5 + i)),
  ...BACKER.map((d, i) => promo(d, 4 + i)),
  ...NEWS.map((d, i) => promo(d, 100 + i, 90 + i, 10)),
  // Legitimate look-alikes. Some are mostly promo by share, but protected.
  promo("kickstarter.com", 93, 10, 5),
  promo("me.kickstarter.com", 40, 39),
  promo("x.backerkit.com", 30, 30),
  promo("pledgebox.com", 60, 60),
  promo("songkick.com", 50, 45, 3),
  // Shares the kickstar prefix but is mostly not promo: blocks the glob.
  promo("kickstarupdates.com", 40, 20),
  // A clean family: its glob collides with nothing.
  promo("promozone1.net", 30),
  promo("promozoneplus.net", 25),
  promo("promozonedeals.net", 20),
  // Singles: one qualifies, one is too small, one is mostly newsletter.
  promo("bigretailer.com", 50, 48),
  promo("tiny.com", 3),
  promo("weeklyletter.org", 40, 0, 40),
  // Noise that must be ignored.
  promo("unknown", 500),
];

const OPTIONS = { minEmails: 20, minShare: 0.9 };

function family(
  families: SenderRuleSuggestionFamily[],
  key: string,
): SenderRuleSuggestionFamily {
  const f = families.find((x) => x.key === key);
  if (!f) throw new Error(`no family ${key}: ${families.map((x) => x.key).join(", ")}`);
  return f;
}

describe("suggestSenderRules", () => {
  const families = suggestSenderRules(STATS, OPTIONS);

  it("groups kickstar*, backer*, news.*.com and promozone* families", () => {
    const kick = family(families, "kickstar*.com");
    expect(kick.kind).toBe("prefix");
    expect(kick.domains.map((d) => d.domain).sort()).toEqual([...KICKSTAR].sort());

    const backer = family(families, "backer*.com");
    expect(backer.kind).toBe("prefix");
    expect(backer.domains.map((d) => d.domain).sort()).toEqual([...BACKER].sort());
    expect(kick.domains.length + backer.domains.length).toBe(31);

    const news = family(families, "news.*.com");
    expect(news.kind).toBe("news-subdomain");
    expect(news.domains.map((d) => d.domain).sort()).toEqual([...NEWS].sort());

    expect(family(families, "promozone*.net").kind).toBe("prefix");
  });

  it("proposes a glob when it collides with nothing", () => {
    const f = family(families, "promozone*.net");
    expect(f.proposedRules).toEqual([
      {
        pattern: "promozone*.net",
        matchType: "glob",
        action: "classify",
        category: "marketing",
      },
    ]);
    expect(f.excludedLegit).toEqual([]);
    expect(f.totalEmails).toBe(75);
  });

  it("falls back to domain rules when the glob hits protected or below-threshold senders", () => {
    const kick = family(families, "kickstar*.com");
    expect(kick.proposedRules.every((r) => r.matchType === "domain")).toBe(true);
    expect(kick.proposedRules.map((r) => r.pattern).sort()).toEqual(
      [...KICKSTAR].sort(),
    );
    expect(kick.excludedLegit).toEqual(["kickstarter.com", "kickstarupdates.com"]);

    const backer = family(families, "backer*.com");
    expect(backer.proposedRules.map((r) => r.pattern).sort()).toEqual(
      [...BACKER].sort(),
    );
    expect(backer.excludedLegit).toEqual(["backerkit.com"]);

    // news.*.com would also match news.<protected>.com.
    const news = family(families, "news.*.com");
    expect(news.proposedRules.map((r) => r.pattern).sort()).toEqual(
      [...NEWS].sort(),
    );
    expect(news.excludedLegit).toEqual([
      "news.backerkit.com",
      "news.kickstarter.com",
      "news.pledgebox.com",
      "news.songkick.com",
    ]);
  });

  it("never proposes a rule that matches a protected or below-threshold sender", () => {
    const legit = [
      "kickstarter.com",
      "me.kickstarter.com",
      "backerkit.com",
      "x.backerkit.com",
      "pledgebox.com",
      "songkick.com",
      "kickstarupdates.com",
    ];
    const rules = families.flatMap((f) =>
      f.proposedRules.map((r, i) => ({
        ...r,
        id: `${f.key}#${i}`,
        createdAt: new Date(0),
      })),
    );
    const matcher = compileRules(rules);
    for (const domain of legit) {
      expect(matcher.match({ fromAddress: `news@${domain}`, senderDomain: domain })).toBeNull();
    }
    const listed = families.flatMap((f) => f.domains.map((d) => d.domain));
    for (const domain of legit) expect(listed).not.toContain(domain);
  });

  it("every proposed rule passes CreateSenderRuleSchema unchanged", () => {
    const all = families.flatMap((f) => f.proposedRules);
    expect(all.length).toBeGreaterThan(0);
    for (const rule of all) {
      const parsed = CreateSenderRuleSchema.safeParse(rule);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.pattern).toBe(rule.pattern);
      expect(rule.action).toBe("classify");
    }
  });

  it("handles singles: threshold, minEmails, newsletter category, noise", () => {
    expect(family(families, "bigretailer.com")).toMatchObject({
      kind: "single",
      totalEmails: 50,
      domains: [{ domain: "bigretailer.com", total: 50, share: 0.96 }],
      proposedRules: [{ pattern: "bigretailer.com", matchType: "domain" }],
    });
    expect(family(families, "weeklyletter.org").proposedRules[0].category).toBe(
      "newsletter",
    );
    const keys = families.map((f) => f.key);
    expect(keys).not.toContain("tiny.com");
    expect(keys).not.toContain("unknown");
  });

  it("sorts families by totalEmails, largest first", () => {
    const totals = families.map((f) => f.totalEmails);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(families[0].key).toBe("news.*.com");
  });

  it("drops families under minEmails and domains under minShare", () => {
    const strict = suggestSenderRules(STATS, { minEmails: 1000, minShare: 0.9 });
    expect(strict).toEqual([]);
    const loose = suggestSenderRules(STATS, { minEmails: 1, minShare: 0.5 });
    // At 50% kickstarupdates.com joins the family, so the glob now only
    // collides with protected senders.
    const kick = family(loose, "kickstar*.com");
    expect(kick.domains.map((d) => d.domain)).toContain("kickstarupdates.com");
    expect(kick.excludedLegit).toEqual(["kickstarter.com"]);
    expect(family(loose, "tiny.com").kind).toBe("single");
  });

  it("excludes domains an enabled existing rule already covers", () => {
    const existing = [
      {
        id: "r1",
        pattern: "promozone*.net",
        matchType: "glob" as const,
        category: "marketing",
        action: "classify",
        createdAt: new Date(0),
      },
      {
        id: "r2",
        pattern: "bigretailer.com",
        matchType: "domain" as const,
        category: "marketing",
        action: "classify",
        createdAt: new Date(0),
        enabled: false, // disabled: does not count
      },
    ];
    const keys = suggestSenderRules(STATS, OPTIONS, existing).map((f) => f.key);
    expect(keys).not.toContain("promozone*.net");
    expect(keys).toContain("bigretailer.com");
  });

  it("gives subdomain members domain rules, never a subdomain wildcard", () => {
    const out = suggestSenderRules(
      [
        promo("dealzonea.io", 30),
        promo("dealzoneb.io", 30),
        promo("dealzonec.io", 30),
        promo("mail.dealzoned.io", 30),
      ],
      OPTIONS,
    );
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("dealzone*.io");
    expect(out[0].proposedRules.map((r) => `${r.matchType}:${r.pattern}`)).toEqual([
      "glob:dealzone*.io",
      "domain:mail.dealzoned.io",
    ]);
  });

  it("proposes no glob when the apex members alone are too few", () => {
    const out = suggestSenderRules(
      [
        promo("brandx.com", 30),
        promo("em.brandxframing.com", 30),
        promo("deals.brandxoutlet.com", 30),
      ],
      OPTIONS,
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("prefix");
    expect(out[0].proposedRules.every((r) => r.matchType === "domain")).toBe(true);
    expect(out[0].proposedRules).toHaveLength(3);
  });

  it("a non-.com news family of 2 gets per-domain rules only", () => {
    const out = suggestSenderRules(
      [promo("news.alphaa.io", 30), promo("news.betab.io", 30)],
      OPTIONS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "news.*.io", kind: "news-subdomain" });
    expect(out[0].proposedRules.map((r) => `${r.matchType}:${r.pattern}`)).toEqual([
      "domain:news.alphaa.io",
      "domain:news.betab.io",
    ]);
    expect(out[0].excludedLegit).toEqual([]);
  });

  it("a non-.com news family of 3 gets the glob only without collisions", () => {
    const three = [
      promo("news.alphaa.io", 30),
      promo("news.betab.io", 30),
      promo("news.gammac.io", 30),
    ];
    const clean = suggestSenderRules(three, OPTIONS);
    expect(clean[0].proposedRules).toEqual([
      {
        pattern: "news.*.io",
        matchType: "glob",
        action: "classify",
        category: "marketing",
      },
    ]);

    // An observed news.<x>.io below the share threshold blocks the glob.
    const mixed = suggestSenderRules(
      [...three, promo("news.realpaper.io", 40, 4)],
      OPTIONS,
    );
    expect(mixed[0].proposedRules.every((r) => r.matchType === "domain")).toBe(true);
    expect(mixed[0].proposedRules).toHaveLength(3);
    expect(mixed[0].excludedLegit).toEqual(["news.realpaper.io"]);
  });

  it("skips punycode labels in the prefix step: they become singles", () => {
    const out = suggestSenderRules(
      [
        promo("xn--aaaa-1.com", 30),
        promo("xn--aaaa-2.com", 30),
        promo("xn--aaaa-3.com", 30),
      ],
      OPTIONS,
    );
    expect(out.map((f) => f.kind)).toEqual(["single", "single", "single"]);
    expect(out.flatMap((f) => f.proposedRules.map((r) => r.matchType))).toEqual([
      "domain",
      "domain",
      "domain",
    ]);
  });

  it("needs three distinct labels for a prefix family; fewer become singles", () => {
    const out = suggestSenderRules(
      [promo("michaelsmith.com", 30), promo("michaeljones.com", 30)],
      OPTIONS,
    );
    expect(out.map((f) => [f.kind, f.key])).toEqual([
      ["single", "michaeljones.com"],
      ["single", "michaelsmith.com"],
    ]);
  });

  it("groups one brand's subdomains into a single sender with per-host domain rules", () => {
    const out = suggestSenderRules(
      [
        promo("brandmail.com", 10),
        promo("news.brandmail.com", 10),
        promo("offers.brandmail.com", 10),
        promo("support.brandmail.com", 10, 1), // mostly not promo
      ],
      OPTIONS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "brandmail.com", kind: "single", totalEmails: 30 });
    expect(out[0].proposedRules.map((r) => `${r.matchType}:${r.pattern}`).sort()).toEqual([
      "domain:brandmail.com",
      "domain:news.brandmail.com",
      "domain:offers.brandmail.com",
    ]);
  });

  it("merges case variants and does not mutate its input", () => {
    const input = Object.freeze([
      Object.freeze(promo("Shoutybrand.com", 15)),
      Object.freeze(promo("shoutybrand.com", 10)),
    ]);
    const out = suggestSenderRules(input, OPTIONS);
    expect(out).toEqual([
      expect.objectContaining({
        key: "shoutybrand.com",
        totalEmails: 25,
      }),
    ]);
  });
});
