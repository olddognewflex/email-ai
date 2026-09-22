import {
  EmailCategorySchema,
  EmailClassificationInput,
  RecommendedActionSchema,
  TypeSafeJudgeRequestSchema,
} from "@email-ai/shared";
import {
  BODY_TRUNCATION_NOTE,
  CLASSIFICATION_QUESTION_SET_VERSION,
  FIELD_TRUNCATION_MARK,
  IMPORTANCE_LEVELS,
  MAX_BODY_CHARS,
  MAX_DOMAIN_CHARS,
  MAX_FROM_CHARS,
  MAX_RULE_REASON_CHARS,
  MAX_RULE_REASONS,
  MAX_SUBJECT_CHARS,
  URGENCY_LEVELS,
  truncateText,
  buildClassificationJudgeRequest,
  buildClassificationQuestions,
  buildClassificationState,
} from "./classification.questions";

const input: EmailClassificationInput = {
  subject: "Your order #1234",
  fromAddress: "orders@shop.example",
  fromName: "Shop",
  cleanedText: "Thanks for your order.",
  ruleCategory: "receipt",
  ruleConfidence: "high",
  ruleReasons: ["subject mentions order"],
  isNewsletter: false,
  isBulk: true,
  senderDomain: "shop.example",
};

describe("buildClassificationState", () => {
  it("nests email, signals and rule-engine output", () => {
    expect(buildClassificationState(input)).toEqual({
      email: {
        from: "Shop <orders@shop.example>",
        subject: "Your order #1234",
        senderDomain: "shop.example",
        body: "Thanks for your order.",
      },
      signals: { isNewsletter: false, isBulk: true },
      ruleEngine: {
        category: "receipt",
        confidence: "high",
        reasons: ["subject mentions order"],
      },
    });
  });

  it("fills placeholders for missing sender, subject and body", () => {
    const state = buildClassificationState({
      ...input,
      fromName: null,
      fromAddress: null,
      subject: null,
      cleanedText: null,
    });
    expect(state.email.from).toBe("Unknown sender");
    expect(state.email.subject).toBe("(no subject)");
    expect(state.email.body).toBe("(no content)");
  });

  it("does not truncate a body at exactly the limit", () => {
    const body = "a".repeat(MAX_BODY_CHARS);
    const state = buildClassificationState({ ...input, cleanedText: body });
    expect(state.email.body).toBe(body);
  });

  it("truncates an over-long body and appends a note", () => {
    const body = "b".repeat(MAX_BODY_CHARS + 5_000);
    const state = buildClassificationState({ ...input, cleanedText: body });
    expect(state.email.body).toBe(
      "b".repeat(MAX_BODY_CHARS) + BODY_TRUNCATION_NOTE,
    );
    expect(state.email.body.length).toBe(
      MAX_BODY_CHARS + BODY_TRUNCATION_NOTE.length,
    );
  });
});

describe("truncateText", () => {
  const isWellFormed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = s.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        return false;
      }
    }
    return true;
  };

  it("returns short text unchanged (no suffix)", () => {
    expect(truncateText("hello", 10, "…")).toBe("hello");
  });

  it("cuts to max and appends the suffix", () => {
    expect(truncateText("abcdef", 3, "…")).toBe("abc…");
  });

  it("never splits a surrogate pair when the cut lands inside an emoji", () => {
    // "ab" + 😀 (2 code units): a cut at 3 would leave a lone high surrogate.
    const out = truncateText("ab😀cd", 3, "…");
    expect(out).toBe("ab…");
    expect(isWellFormed(out)).toBe(true);
  });

  it("keeps a whole emoji that fits exactly", () => {
    expect(truncateText("ab😀cd", 4, "…")).toBe("ab😀…");
  });

  it("body truncation stays well-formed with an emoji at the boundary", () => {
    const body = "x".repeat(MAX_BODY_CHARS - 1) + "😀" + "tail";
    const state = buildClassificationState({ ...input, cleanedText: body });
    expect(state.email.body).toBe(
      "x".repeat(MAX_BODY_CHARS - 1) + BODY_TRUNCATION_NOTE,
    );
    expect(isWellFormed(state.email.body)).toBe(true);
  });
});

describe("state field caps", () => {
  it("caps subject, from, domain, and each rule reason", () => {
    const state = buildClassificationState({
      ...input,
      subject: "s".repeat(MAX_SUBJECT_CHARS + 50),
      fromName: "n".repeat(MAX_FROM_CHARS + 50),
      senderDomain: "d".repeat(MAX_DOMAIN_CHARS + 50),
      ruleReasons: ["r".repeat(MAX_RULE_REASON_CHARS + 50)],
    });
    expect(state.email.subject).toBe(
      "s".repeat(MAX_SUBJECT_CHARS) + FIELD_TRUNCATION_MARK,
    );
    expect(state.email.from).toBe(
      "n".repeat(MAX_FROM_CHARS) + FIELD_TRUNCATION_MARK,
    );
    expect(state.email.senderDomain).toHaveLength(MAX_DOMAIN_CHARS);
    expect(state.ruleEngine.reasons[0]).toBe(
      "r".repeat(MAX_RULE_REASON_CHARS) + FIELD_TRUNCATION_MARK,
    );
  });

  it("keeps at most MAX_RULE_REASONS reasons", () => {
    const reasons = Array.from(
      { length: MAX_RULE_REASONS + 5 },
      (_, i) => `r${i}`,
    );
    const state = buildClassificationState({ ...input, ruleReasons: reasons });
    expect(state.ruleEngine.reasons).toEqual(
      reasons.slice(0, MAX_RULE_REASONS),
    );
  });

  it("an emoji-heavy subject at the cap stays well-formed", () => {
    const subject = "a" + "😀".repeat(MAX_SUBJECT_CHARS);
    const state = buildClassificationState({ ...input, subject });
    // 1 + 2k code units: the cut at MAX_SUBJECT_CHARS (even) splits an emoji.
    expect(state.email.subject.endsWith("\ud83d" + FIELD_TRUNCATION_MARK)).toBe(
      false,
    );
    expect(state.email.subject.length).toBeLessThanOrEqual(
      MAX_SUBJECT_CHARS + FIELD_TRUNCATION_MARK.length,
    );
  });
});

describe("CLASSIFICATION_QUESTION_SET_VERSION", () => {
  it("is a non-empty dated version string", () => {
    expect(CLASSIFICATION_QUESTION_SET_VERSION).toMatch(
      /^\d{4}-\d{2}-\d{2}\.\d+$/,
    );
  });
});

describe("buildClassificationQuestions", () => {
  const questions = buildClassificationQuestions();

  it("asks exactly the five triage questions", () => {
    expect(Object.keys(questions).sort()).toEqual([
      "category",
      "importance",
      "recommendedAction",
      "sensitive",
      "urgency",
    ]);
  });

  it("category is a choice whose criteria keys are exactly EmailCategorySchema", () => {
    const q = questions.category;
    expect(q.type).toBe("choice");
    if (q.type !== "choice") return;
    expect(Object.keys(q.criteria).sort()).toEqual(
      [...EmailCategorySchema.options].sort(),
    );
    for (const entry of Object.values(q.criteria)) {
      expect(Object.keys(entry as object).sort()).toEqual([
        "examples",
        "not_for",
        "what",
      ]);
    }
  });

  it("recommendedAction is a choice whose keys are exactly RecommendedActionSchema", () => {
    const q = questions.recommendedAction;
    expect(q.type).toBe("choice");
    if (q.type !== "choice") return;
    expect(Object.keys(q.criteria).sort()).toEqual(
      [...RecommendedActionSchema.options].sort(),
    );
    expect(JSON.stringify(q.instructions)).toMatch(/nothing is executed/);
  });

  it.each([
    ["importance", IMPORTANCE_LEVELS],
    ["urgency", URGENCY_LEVELS],
  ])("%s is a 5-level score ordered lowest → highest", (id, levels) => {
    const q = questions[id];
    expect(q.type).toBe("score");
    if (q.type !== "score") return;
    expect(q.criteria).toHaveLength(5);
    expect(levels).toHaveLength(5);
    q.criteria.forEach((c, i) => {
      expect(String(c).startsWith(`${levels[i]} —`)).toBe(true);
    });
  });

  it("sensitive is a noul question with true/false criteria", () => {
    const q = questions.sensitive;
    expect(q.type).toBe("noul");
    if (q.type !== "noul") return;
    expect(Object.keys(q.criteria ?? {}).sort()).toEqual(["false", "true"]);
  });

  it("instructions reference state paths and treat rules as a hint", () => {
    const text = JSON.stringify(questions.category.instructions);
    expect(text).toContain("`email.body`");
    expect(text).toContain("`ruleEngine`");
    expect(text).toMatch(/hint, not ground truth/);
  });

  it("builds a request that satisfies the shared TypeSafe request schema", () => {
    const req = buildClassificationJudgeRequest(input);
    expect(() => TypeSafeJudgeRequestSchema.parse(req)).not.toThrow();
  });
});
