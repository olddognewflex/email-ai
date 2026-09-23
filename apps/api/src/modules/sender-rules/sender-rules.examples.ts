import type {
  CreateSenderRuleInput,
  SenderRuleMatchType,
} from "@email-ai/shared";

/**
 * Example sender rules for the promo families observed in classification
 * history (qi note "Email unsubscribe list 2026-09-23"). Documentation and
 * test fixtures only: nothing seeds these into the database.
 *
 * None of them may match a protected sender (see protected-senders.ts):
 * kickstarter.com, *.backerkit.com, pledgebox.com, songkick.com.
 */
export const exampleSenderRules: (CreateSenderRuleInput & {
  pattern: string;
  matchType: SenderRuleMatchType;
})[] = [
  {
    // news.<name>.com finance promos: one label between "news." and ".com".
    // Does not match any protected sender seen in mail, but would match a
    // news.<protected>.com subdomain, so creating it returns a warning.
    pattern: "news.*.com",
    matchType: "glob",
    action: "classify",
    category: "marketing",
    note: "news.<name>.com finance promo family",
  },
  {
    // kickstar* gadget promos, including trendingkickstarter.com and
    // me-kickstarter.com, but not the real kickstarter.com. No dot before
    // "kickstar", so me.kickstarter.com is never reached either.
    pattern: "^(?!kickstarter\\.com$)[a-z0-9-]*kickstar[a-z0-9-]*\\.(?:com|net)$",
    matchType: "regex",
    action: "trash",
    note: "kickstar* crowdfunding gadget promo family",
  },
  {
    // backer* gadget promos, not backerkit.com (or its subdomains: the
    // pattern has no dot before "backer").
    pattern: "^(?!backerkit\\.com$)backer[a-z0-9-]*\\.(?:com|net)$",
    matchType: "regex",
    action: "trash",
    note: "backer* crowdfunding gadget promo family",
  },
  {
    // Same family, domains that share no prefix with the rest.
    pattern: "kstgadgets.com",
    matchType: "domain",
    action: "trash",
    note: "crowdfunding gadget promo",
  },
  {
    pattern: "kickbounty.com",
    matchType: "domain_suffix",
    action: "classify",
    category: "marketing",
  },
  {
    pattern: "team@kickstargo.com",
    matchType: "address",
    action: "classify",
    category: "marketing",
  },
];

/** Senders the examples should catch, with the pattern expected to win. */
export const exampleSenderMatches: {
  fromAddress: string;
  senderDomain: string;
  expectedPattern: string;
}[] = [
  {
    fromAddress: "reply@news.getthefinnewsnow.com",
    senderDomain: "news.getthefinnewsnow.com",
    expectedPattern: "news.*.com",
  },
  {
    fromAddress: "email@kickstartrends.com",
    senderDomain: "kickstartrends.com",
    expectedPattern: exampleSenderRules[1].pattern,
  },
  {
    fromAddress: "hi@trendingkickstarter.com",
    senderDomain: "trendingkickstarter.com",
    expectedPattern: exampleSenderRules[1].pattern,
  },
  {
    fromAddress: "hi@me-kickstarter.com",
    senderDomain: "me-kickstarter.com",
    expectedPattern: exampleSenderRules[1].pattern,
  },
  {
    fromAddress: "info@backerpledge.com",
    senderDomain: "backerpledge.com",
    expectedPattern: exampleSenderRules[2].pattern,
  },
  {
    fromAddress: "deals@kstgadgets.com",
    senderDomain: "kstgadgets.com",
    expectedPattern: "kstgadgets.com",
  },
  {
    fromAddress: "x@mail.kickbounty.com",
    senderDomain: "mail.kickbounty.com",
    expectedPattern: "kickbounty.com",
  },
  {
    // Address outranks the kickstar* regex that also matches the domain.
    fromAddress: "team@kickstargo.com",
    senderDomain: "kickstargo.com",
    expectedPattern: "team@kickstargo.com",
  },
];

/** Legitimate senders no shipped example may match. */
export const protectedSenderProbes: {
  fromAddress: string;
  senderDomain: string;
}[] = [
  { fromAddress: "no-reply@kickstarter.com", senderDomain: "kickstarter.com" },
  {
    fromAddress: "hello@me.kickstarter.com",
    senderDomain: "me.kickstarter.com",
  },
  { fromAddress: "team@backerkit.com", senderDomain: "backerkit.com" },
  { fromAddress: "team@x.backerkit.com", senderDomain: "x.backerkit.com" },
  { fromAddress: "support@pledgebox.com", senderDomain: "pledgebox.com" },
  { fromAddress: "news@songkick.com", senderDomain: "songkick.com" },
];
