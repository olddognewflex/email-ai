import {
  EmailCategory,
  EmailClassificationInput,
  RecommendedAction,
  TypeSafeChoiceQuestion,
  TypeSafeJudgeRequest,
  TypeSafeNoulQuestion,
  TypeSafeScoreQuestion,
} from "@email-ai/shared";

/**
 * TypeSafe (System One / Jev) question set for email triage.
 *
 * Instead of a free-text prompt, the email is sent as structured `state` and
 * the model answers five typed questions in one call (they run in parallel
 * and independently, so each set of instructions must stand on its own —
 * question ids are never shown to the model).
 *
 * The mapping from answers to an `EmailClassificationOutput` lives in
 * `classification.judgments.ts`.
 */

/**
 * Version of the state shape + question wording below. Bump it whenever
 * either changes; it is persisted in every TypeSafe row's `rawResponse`
 * envelope so a classification can be tied to the question set that made it.
 */
export const CLASSIFICATION_QUESTION_SET_VERSION = "2026-09-22.1";

/**
 * Field caps. TypeSafe allows 32k tokens for state + the longest question,
 * and a request over the limit is a 422. Every free-text field is capped so
 * no single email can produce an oversized request: 12k body chars
 * (~3k tokens) plus the small caps below keeps the state comfortably under
 * the limit with room for the category question's structured criteria.
 */
export const MAX_BODY_CHARS = 12_000;
export const MAX_FROM_CHARS = 320;
export const MAX_SUBJECT_CHARS = 500;
export const MAX_DOMAIN_CHARS = 255;
export const MAX_RULE_REASON_CHARS = 200;
export const MAX_RULE_REASONS = 10;

export const BODY_TRUNCATION_NOTE =
  "\n\n[… body truncated for length; judge from the portion above]";
export const FIELD_TRUNCATION_MARK = "…";

/**
 * Truncate to at most `max` UTF-16 code units (before `suffix`) without
 * splitting a surrogate pair: if the cut lands between a high and low
 * surrogate, the dangling high surrogate is dropped too.
 */
export function truncateText(text: string, max: number, suffix = ""): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return cut + suffix;
}

/** Question ids — used only to key answers; not shown to the model. */
export const QUESTION_IDS = {
  category: "category",
  recommendedAction: "recommendedAction",
  importance: "importance",
  urgency: "urgency",
  sensitive: "sensitive",
} as const;

/** Ordered lowest → highest; index === score level. */
export const IMPORTANCE_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "critical",
] as const;

/** Ordered lowest → highest; index === score level. */
export const URGENCY_LEVELS = [
  "none",
  "eventually",
  "this_week",
  "today",
  "immediate",
] as const;

export type ClassificationState = {
  email: {
    from: string;
    subject: string;
    senderDomain: string;
    body: string;
  };
  signals: {
    isNewsletter: boolean;
    isBulk: boolean;
  };
  ruleEngine: {
    category: string | null;
    confidence: string | null;
    reasons: string[];
  };
};

export function buildClassificationState(
  input: EmailClassificationInput,
): ClassificationState {
  const rawFrom = input.fromName
    ? `${input.fromName} <${input.fromAddress ?? "unknown"}>`
    : (input.fromAddress ?? "Unknown sender");
  const from = truncateText(rawFrom, MAX_FROM_CHARS, FIELD_TRUNCATION_MARK);

  const text = input.cleanedText ?? "";
  const body = text
    ? truncateText(text, MAX_BODY_CHARS, BODY_TRUNCATION_NOTE)
    : "(no content)";

  const subject = input.subject
    ? truncateText(input.subject, MAX_SUBJECT_CHARS, FIELD_TRUNCATION_MARK)
    : "(no subject)";

  return {
    email: {
      from,
      subject,
      senderDomain: truncateText(input.senderDomain, MAX_DOMAIN_CHARS),
      body,
    },
    signals: {
      isNewsletter: input.isNewsletter,
      isBulk: input.isBulk,
    },
    ruleEngine: {
      category: input.ruleCategory,
      confidence: input.ruleConfidence,
      reasons: input.ruleReasons
        .slice(0, MAX_RULE_REASONS)
        .map((r) =>
          truncateText(r, MAX_RULE_REASON_CHARS, FIELD_TRUNCATION_MARK),
        ),
    },
  };
}

// ── category ──────────────────────────────────────────────────────────────

const CATEGORY_CRITERIA: Record<
  EmailCategory,
  { what: string; not_for: string; examples: string[] }
> = {
  needs_attention: {
    what: "Mail from a real person or organisation that asks the recipient to act or decide: a request, an approval, a deadline, a problem with their account or order that they must resolve.",
    not_for:
      "Personal chit-chat with no ask (personal), automated alerts that need no decision (notification), promotions with a 'buy now' call to action (marketing).",
    examples: [
      "Your landlord asks you to confirm a repair visit time",
      "Accountant needs signed forms back by Friday",
      "Payment failed — update your card to keep your subscription",
    ],
  },
  read_later: {
    what: "Worthwhile, non-urgent content the recipient would likely want to read but that is not a subscribed digest and needs no action.",
    not_for:
      "Opted-in digests and mailing lists (newsletter), sales content (marketing), anything needing a reply (needs_attention or personal).",
    examples: [
      "A colleague shares a long article 'for when you have time'",
      "Conference talk recordings are now available",
    ],
  },
  archive: {
    what: "Low-value informational mail worth keeping for the record but not worth reading now, that fits no more specific category.",
    not_for:
      "Receipts and invoices (receipt), automated system alerts (notification), newsletters (newsletter).",
    examples: [
      "Updated terms of service notice",
      "Meeting notes circulated after a meeting you attended",
    ],
  },
  delete: {
    what: "Junk with no value to keep: obvious spam, phishing-looking bait, or expired one-off mail that fits no other category.",
    not_for:
      "Legitimate promotions from a known sender (marketing), security alerts from a real service (notification).",
    examples: [
      "Unsolicited 'you have won a prize' email",
      "Event reminder for an event that already happened",
    ],
  },
  newsletter: {
    what: "Bulk mail whose primary intent is to INFORM: digests, subscribed content, blogs, mailing lists the recipient opted into.",
    not_for:
      "Mail whose dominant purpose is to drive a purchase — that is marketing even when it has an unsubscribe link or a bulk sender.",
    examples: [
      "Weekly engineering digest",
      "A Substack post from a writer the recipient follows",
      "Community mailing list roundup",
    ],
  },
  marketing: {
    what: "Bulk mail whose primary intent is to SELL: promotions, sales, discount offers, '% off', 'limited time', product launches, abandoned-cart reminders.",
    not_for:
      "Informational digests without a sales push (newsletter), confirmations of an actual purchase (receipt).",
    examples: [
      "20% off everything this weekend only",
      "You left items in your cart",
      "Introducing our new product line — shop now",
    ],
  },
  receipt: {
    what: "Proof of a completed transaction: purchase confirmations, receipts, invoices, order and payment confirmations, shipping confirmations for an order.",
    not_for:
      "Promotions that merely mention prices (marketing), failed-payment problems needing action (needs_attention).",
    examples: [
      "Your order #1234 has been confirmed",
      "Invoice INV-2026-091 attached",
      "Payment received — thank you",
    ],
  },
  notification: {
    what: "Automated alerts and system messages from a service about the recipient's account or activity, including security alerts (new sign-in, password changed, 2FA codes).",
    not_for:
      "Human-written mail (personal), sales content (marketing), transaction proofs (receipt), social-network activity (social).",
    examples: [
      "New sign-in to your account from Chrome on Windows",
      "Your build failed on main",
      "Your verification code is 482913",
    ],
  },
  social: {
    what: "Activity from social networks and community platforms: likes, follows, mentions, connection requests, group posts.",
    not_for:
      "Direct messages from a person written as ordinary email (personal), platform security alerts (notification).",
    examples: [
      "Someone commented on your post",
      "You have 3 new connection requests",
    ],
  },
  personal: {
    what: "Direct human correspondence written by an individual to the recipient, not bulk and not automated.",
    not_for:
      "Anything sent in bulk or by a system, even if it uses the recipient's first name.",
    examples: [
      "A friend asking about weekend plans",
      "A family member sharing photos",
      "A one-to-one note from a colleague",
    ],
  },
  unknown: {
    what: "None of the other categories fits, or there is too little content (empty body, unreadable text) to tell.",
    not_for:
      "Emails that plausibly fit another category — prefer the best-fitting category over unknown.",
    examples: [
      "Blank email with no subject",
      "Body is only an image placeholder",
    ],
  },
};

// ── recommended action ───────────────────────────────────────────────────

const ACTION_CRITERIA: Record<RecommendedAction, string> = {
  read_now:
    "Open and read it soon: important or time-sensitive content, but no reply is required.",
  reply_needed: "The sender expects a written response from the recipient.",
  schedule_reply:
    "A response is expected, but not urgently; plan to reply later.",
  archive:
    "Keep for the record without reading now (e.g. receipts, confirmations).",
  mark_read:
    "Glance or skim and mark as read; nothing further to do (e.g. newsletters, routine alerts).",
  delete: "No value in keeping it (spam, junk, expired one-off mail).",
  unsubscribe:
    "Unwanted recurring bulk mail the recipient would likely prefer to stop receiving (typically marketing).",
  flag_for_followup:
    "Needs action later or depends on something pending; set a reminder.",
  delegate: "Someone else is better placed to handle it; forward it on.",
  no_action: "Nothing to do and nothing worth keeping a record of.",
};

// ── importance / urgency ─────────────────────────────────────────────────

const IMPORTANCE_CRITERIA = [
  "none — no value to the recipient: marketing, promotions, spam",
  "low — nice to have: newsletters and digests, social-network activity, routine notifications",
  "medium — worth keeping or reading eventually: receipts, invoices, order and shipping confirmations, routine account notices",
  "high — matters personally or professionally: direct correspondence from a real person, requests from colleagues, family or clients",
  "critical — serious consequences if missed: security alerts (unrecognised sign-in, password changed), account compromise, legal or financial deadlines",
];

const URGENCY_CRITERIA = [
  "none — never time-sensitive: receipts, newsletters, promotions, informational notices",
  "eventually — should be handled at some point, no deadline: a friendly note that can be answered whenever",
  "this_week — a deadline or expectation within the next several days: RSVP by Friday, forms due next week",
  "today — should be handled today: a same-day meeting change, a delivery arriving today that needs someone home",
  "immediate — act within hours: a suspicious sign-in or password reset you did not request, an outage, an urgent request from a manager",
];

const RULE_HINT_NOTE =
  "`ruleEngine` holds the output of a simple keyword/header rule engine. Treat it as a hint, not ground truth — override it whenever the email itself says otherwise.";

export function buildClassificationQuestions(): TypeSafeJudgeRequest["questions"] {
  const category: TypeSafeChoiceQuestion = {
    type: "choice",
    instructions: [
      "Which category best describes this email? The email is in `email` (sender `email.from`, `email.subject`, `email.senderDomain`, body `email.body`); `signals.isNewsletter` means it carries a List-Unsubscribe header and `signals.isBulk` means it came from a no-reply/bulk sender.",
      "Newsletter vs marketing: judge by dominant intent. If the dominant purpose is driving a purchase it is marketing even when it has an unsubscribe link or a bulk sender; if it is sharing information or content, it is newsletter.",
      "Receipts and invoices are receipt. Security alerts are notification. Direct human correspondence is personal. Choose unknown only when nothing else fits or there is too little content to judge.",
      RULE_HINT_NOTE,
    ],
    criteria: CATEGORY_CRITERIA,
  };

  const recommendedAction: TypeSafeChoiceQuestion = {
    type: "choice",
    instructions: [
      "What should the recipient most sensibly do with this email (`email`)? This is a recommendation shown to the user only — nothing is executed automatically.",
      "Typical pairings: receipts → archive; newsletters → mark_read (or unsubscribe if clearly unwanted); marketing → unsubscribe or delete; personal mail → read_now or reply_needed.",
      RULE_HINT_NOTE,
    ],
    criteria: ACTION_CRITERIA,
  };

  const importance: TypeSafeScoreQuestion = {
    type: "score",
    instructions: [
      "How important is this email (`email`) to its recipient? Pick the level whose situation best matches.",
      RULE_HINT_NOTE,
    ],
    criteria: IMPORTANCE_CRITERIA,
  };

  const urgency: TypeSafeScoreQuestion = {
    type: "score",
    instructions: [
      "How soon does this email (`email`) need the recipient's attention? Judge by any deadline, time reference or risk in `email.subject` and `email.body`. Pick the level whose situation best matches.",
    ],
    criteria: URGENCY_CRITERIA,
  };

  const sensitive: TypeSafeNoulQuestion = {
    type: "noul",
    instructions:
      "Does this email (`email`) involve a sensitive matter — account security or compromise, credentials or verification codes, legal matters, a financial dispute or unexpected charge, or health — where a human should double-check the automated triage before relying on it?",
    criteria: {
      true: "Yes: security/account compromise, credentials, legal, financial dispute, or health content is present.",
      false:
        "No: routine mail such as newsletters, promotions, ordinary receipts, social updates or casual correspondence.",
    },
  };

  return {
    [QUESTION_IDS.category]: category,
    [QUESTION_IDS.recommendedAction]: recommendedAction,
    [QUESTION_IDS.importance]: importance,
    [QUESTION_IDS.urgency]: urgency,
    [QUESTION_IDS.sensitive]: sensitive,
  };
}

/** Full TypeSafe request for one email. */
export function buildClassificationJudgeRequest(
  input: EmailClassificationInput,
): TypeSafeJudgeRequest {
  return {
    state: buildClassificationState(input),
    questions: buildClassificationQuestions(),
  };
}
