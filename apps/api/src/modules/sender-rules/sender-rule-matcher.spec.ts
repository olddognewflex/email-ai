import { CreateSenderRuleSchema, SenderRuleMatchType } from "@email-ai/shared";
import {
  MatchableSenderRule,
  compileRules,
  globToRegExp,
} from "./sender-rule-matcher";
import {
  exampleSenderMatches,
  exampleSenderRules,
  protectedSenderProbes,
} from "./sender-rules.examples";
import { isProtectedDomain, protectedHits } from "./protected-senders";

let seq = 0;
function rule(
  matchType: SenderRuleMatchType,
  pattern: string,
  extra: Partial<MatchableSenderRule> = {},
): MatchableSenderRule {
  seq++;
  return {
    id: `r${String(seq).padStart(3, "0")}`,
    pattern,
    matchType,
    category: "marketing",
    action: "classify",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
    ...extra,
  };
}

const sender = (fromAddress: string | null, senderDomain: string | null) => ({
  fromAddress,
  senderDomain,
});

/** Deterministic Fisher-Yates with a small LCG. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("compileRules — precedence", () => {
  const all = [
    rule("regex", "^team@promo\\.example\\.com$"),
    rule("glob", "*.example.com"),
    rule("domain_suffix", "example.com"),
    rule("domain", "promo.example.com"),
    rule("address", "team@promo.example.com"),
  ];
  const who = sender("Team@Promo.Example.com", "promo.example.com");

  it("address > domain > domain_suffix > glob > regex", () => {
    const ranked: SenderRuleMatchType[] = [];
    let remaining = all.slice();
    while (remaining.length) {
      const hit = compileRules(remaining).match(who);
      expect(hit).not.toBeNull();
      ranked.push(hit!.rule.matchType);
      remaining = remaining.filter((r) => r !== hit!.rule);
    }
    expect(ranked).toEqual([
      "address",
      "domain",
      "domain_suffix",
      "glob",
      "regex",
    ]);
  });

  it("is independent of input order", () => {
    for (let seed = 1; seed <= 25; seed++) {
      expect(compileRules(shuffled(all, seed)).match(who)?.rule.id).toBe(
        all[4].id,
      );
    }
  });

  it("within a type, the longer pattern wins", () => {
    const short = rule("domain_suffix", "example.com");
    const long = rule("domain_suffix", "promo.example.com");
    for (const order of [
      [short, long],
      [long, short],
    ]) {
      expect(compileRules(order).match(who)?.rule).toBe(long);
    }
  });

  it("equal type and length: older createdAt wins, then lower id", () => {
    const t = new Date("2026-01-01T00:00:00Z");
    const older = rule("glob", "promo.*.com", {
      createdAt: new Date("2025-12-31T00:00:00Z"),
    });
    const newer = rule("glob", "*romo.*.com", { createdAt: t });
    expect(compileRules([newer, older]).match(who)?.rule).toBe(older);

    const a = rule("glob", "promo.*.com", { id: "a", createdAt: t });
    const b = rule("glob", "*romo.*.com", { id: "b", createdAt: t });
    for (let seed = 1; seed <= 10; seed++) {
      expect(compileRules(shuffled([b, a], seed)).match(who)?.rule.id).toBe(
        "a",
      );
    }
  });

  it("skips disabled rules and stored regexes that do not compile or are unsafe", () => {
    const m = compileRules([
      rule("address", "team@promo.example.com", { enabled: false }),
      rule("regex", "(abc"),
      rule("regex", "^(a+)+$"),
      rule("domain", "promo.example.com"),
    ]);
    expect(m.size).toBe(1);
    // Disabled rules are filtered, not "skipped"; bad regexes are reported.
    expect(m.skipped).toHaveLength(2);
    expect(m.match(who)?.rule.matchType).toBe("domain");
  });
});

describe("compileRules — semantics", () => {
  it("address is exact and case-insensitive", () => {
    const m = compileRules([rule("address", "team@kickstargo.com")]);
    expect(m.match(sender("TEAM@KickstarGo.com", "kickstargo.com"))).toEqual({
      rule: expect.objectContaining({ pattern: "team@kickstargo.com" }),
      matchedOn: "address",
    });
    expect(m.match(sender("news@kickstargo.com", "kickstargo.com"))).toBeNull();
  });

  it("domain is exact: a subdomain does not match", () => {
    const m = compileRules([rule("domain", "kstgadgets.com")]);
    expect(m.match(sender("a@kstgadgets.com", "kstgadgets.com"))?.matchedOn).toBe(
      "domain",
    );
    expect(m.match(sender("a@x.kstgadgets.com", "x.kstgadgets.com"))).toBeNull();
  });

  it("domain_suffix respects the label boundary (kick.com ≠ songkick.com)", () => {
    const m = compileRules([rule("domain_suffix", "kick.com")]);
    expect(m.match(sender("a@kick.com", "kick.com"))).not.toBeNull();
    expect(m.match(sender("a@mail.kick.com", "mail.kick.com"))).not.toBeNull();
    expect(m.match(sender("a@songkick.com", "songkick.com"))).toBeNull();
  });

  it("glob * stays within one label", () => {
    const m = compileRules([rule("glob", "news.*.com")]);
    expect(m.match(sender("a@news.foo.com", "news.foo.com"))).not.toBeNull();
    expect(m.match(sender("a@news.a.b.com", "news.a.b.com"))).toBeNull();
    expect(m.match(sender("a@xnews.foo.com", "xnews.foo.com"))).toBeNull();
    expect(m.match(sender("a@news.foo.com.evil", "news.foo.com.evil"))).toBeNull();
  });

  it("glob ? is exactly one character within a label", () => {
    const re = globToRegExp("kick?.com");
    expect(re.test("kicks.com")).toBe(true);
    expect(re.test("kick.com")).toBe(false);
    expect(re.test("kick..com")).toBe(false);
  });

  it("a glob * before @ matches dots in the local part; after @ it stays in one label", () => {
    const m = compileRules([rule("glob", "*@kickstargo.com")]);
    expect(
      m.match(sender("first.last@kickstargo.com", "kickstargo.com"))?.matchedOn,
    ).toBe("address");
    expect(m.match(sender("a@x.kickstargo.com", "x.kickstargo.com"))).toBeNull();

    const d = compileRules([rule("glob", "news@*.example.com")]);
    expect(d.match(sender("news@a.example.com", "a.example.com"))).not.toBeNull();
    expect(d.match(sender("news@a.b.example.com", "a.b.example.com"))).toBeNull();
    expect(globToRegExp("a?b@x.com").test("a.b@x.com")).toBe(true);
    expect(globToRegExp("a?b.com").test("a.b.com")).toBe(false);
  });

  it("a glob containing @ targets the full address", () => {
    const m = compileRules([rule("glob", "team@kickstar*.com")]);
    expect(
      m.match(sender("team@kickstarnow.com", "kickstarnow.com"))?.matchedOn,
    ).toBe("address");
    expect(m.match(sender("info@kickstarnow.com", "kickstarnow.com"))).toBeNull();
    // Domain-only glob never sees the local part.
    const d = compileRules([rule("glob", "team*")]);
    expect(d.match(sender("team@x.com", "x.com"))).toBeNull();
  });

  it("regex is case-insensitive and targets the address only when it contains @", () => {
    const dom = compileRules([rule("regex", "^backer[a-z]+\\.com$")]);
    expect(
      dom.match(sender("a@BackerPledge.com", "BackerPledge.com"))?.matchedOn,
    ).toBe("domain");
    const addr = compileRules([rule("regex", "^info@backer")]);
    expect(
      addr.match(sender("INFO@backerpledge.com", "backerpledge.com"))?.matchedOn,
    ).toBe("address");
  });

  it("never matches an unknown sender domain or a null from address", () => {
    // Built directly: validation rejects ".*" and "unkn*" as too broad, but
    // the matcher stays permissive for whatever rows are stored.
    const m = compileRules([
      rule("glob", "unkn*"),
      rule("regex", ".*"),
      rule("regex", ".*@.*"),
      rule("address", "a@b.com"),
    ]);
    expect(m.match(sender(null, "unknown"))).toBeNull();
    expect(m.match(sender(null, null))).toBeNull();
    expect(m.match(sender("not-an-address", "unknown"))?.matchedOn).not.toBe(
      "domain",
    );
    // Null address: address-targeted rules cannot match, domain ones still can.
    expect(m.match(sender(null, "b.com"))?.matchedOn).toBe("domain");
  });
});

describe("compileRules — hostile input", () => {
  it("returns quickly on a 10k-character sender, even with an unsafe stored regex", () => {
    const m = compileRules([
      rule("regex", "^(a+)+$"), // unsafe: skipped at compile time
      rule("regex", "^(?:a|a)*x"), // unsafe by the structural check
      rule("regex", "^[a-z0-9-]*kickstar[a-z0-9-]*\\.com$"),
      rule("glob", "*@kick*.com"),
      rule("glob", "news.*.com"),
    ]);
    expect(m.size).toBe(3);
    const long = "a".repeat(10_000);
    const started = Date.now();
    expect(m.match(sender(`${long}!@${long}.com`, `${long}!.com`))).toBeNull();
    expect(m.match(sender(`${long}!`, `${long}!`))).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("truncates values before matching (address 320, domain 253)", () => {
    const local = "a".repeat(400);
    const m = compileRules([rule("regex", "@x\\.com$")]);
    // The "@x.com" tail is past the 320-character cut.
    expect(m.match(sender(`${local}@x.com`, "x.com"))).toBeNull();
    expect(m.match(sender("a@x.com", "x.com"))).not.toBeNull();
  });
});

describe("shipped examples", () => {
  const examples = exampleSenderRules.map((r, i) =>
    rule(r.matchType, r.pattern, {
      id: `ex${i}`,
      category: r.category ?? "delete",
    }),
  );
  const matcher = compileRules(examples);

  it.each(exampleSenderMatches)(
    "$fromAddress is caught by $expectedPattern",
    ({ fromAddress, senderDomain, expectedPattern }) => {
      expect(matcher.match({ fromAddress, senderDomain })?.rule.pattern).toBe(
        expectedPattern,
      );
    },
  );

  it.each(exampleSenderRules)(
    "example $pattern passes CreateSenderRuleSchema",
    (example) => {
      expect(CreateSenderRuleSchema.safeParse(example).success).toBe(true);
    },
  );

  it.each(protectedSenderProbes)(
    "no example matches protected sender $senderDomain",
    (probe) => {
      expect(isProtectedDomain(probe.senderDomain)).toBe(true);
      expect(matcher.match(probe)).toBeNull();
    },
  );

  it.each(exampleSenderRules.filter((r) => r.pattern !== "news.*.com"))(
    "example $pattern has no protected hits",
    ({ pattern, matchType }) => {
      expect(protectedHits(pattern, matchType)).toEqual([]);
    },
  );

  it("news.*.com would warn: it also covers news.<protected>.com", () => {
    // Not a hit on any protected sender seen in mail (probes above), but a
    // news.kickstarter.com sender would match, so creating it warns.
    expect(protectedHits("news.*.com", "glob")).toEqual([
      "kickstarter.com",
      "backerkit.com",
      "pledgebox.com",
      "songkick.com",
    ]);
    expect(
      matcher.match({
        fromAddress: "a@news.kickstarter.com",
        senderDomain: "news.kickstarter.com",
      })?.rule.pattern,
    ).toBe("news.*.com");
  });
});

describe("protectedHits", () => {
  it.each<[SenderRuleMatchType, string, string[]]>([
    ["domain_suffix", "kickstarter.com", ["kickstarter.com"]],
    ["domain", "me.kickstarter.com", ["kickstarter.com"]],
    ["address", "news@x.backerkit.com", ["backerkit.com"]],
    ["glob", "kickstar*.com", ["kickstarter.com"]],
    ["glob", "*kick.com", ["songkick.com"]],
    ["regex", "backer", ["backerkit.com"]],
    ["domain_suffix", "kick.com", []],
    ["glob", "promo.*.com", []],
  ])("%s %s → %j", (matchType, pattern, expected) => {
    expect(protectedHits(pattern, matchType)).toEqual(expected);
  });
});
