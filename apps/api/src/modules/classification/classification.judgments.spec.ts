import { TypeSafeAnswer } from "@email-ai/shared";
import {
  HIGH_CONFIDENCE_THRESHOLD,
  MAX_REASON_LENGTH,
  MEDIUM_CONFIDENCE_THRESHOLD,
  SENSITIVE_REVIEW_THRESHOLD,
  mapJudgmentsToOutput,
} from "./classification.judgments";

interface Overrides {
  category?: string;
  categoryConfidence?: number;
  action?: string;
  actionConfidence?: number;
  importance?: number;
  urgency?: number;
  sensitive?: number;
}

function answers(o: Overrides = {}): Record<string, TypeSafeAnswer> {
  const category = o.category ?? "receipt";
  const action = o.action ?? "archive";
  return {
    category: {
      type: "choice",
      choice: category,
      confidence: o.categoryConfidence ?? 0.9,
      probabilities: { [category]: 0.91, unknown: 0.09 },
    },
    recommendedAction: {
      type: "choice",
      choice: action,
      confidence: o.actionConfidence ?? 0.85,
      probabilities: { [action]: 0.84, no_action: 0.16 },
    },
    importance: {
      type: "score",
      score: o.importance ?? 2.1,
      confidence: 0.8,
      probabilities: { "0": 0, "1": 0.1, "2": 0.7, "3": 0.2, "4": 0 },
    },
    urgency: {
      type: "score",
      score: o.urgency ?? 0.2,
      confidence: 0.8,
      probabilities: { "0": 0.8, "1": 0.2, "2": 0, "3": 0, "4": 0 },
    },
    sensitive: { type: "noul", noul: o.sensitive ?? 0.05 },
  };
}

const noRules = { ruleCategory: null, ruleConfidence: null };

describe("mapJudgmentsToOutput", () => {
  it("maps a confident receipt judgment without review", () => {
    const { output, diagnostics } = mapJudgmentsToOutput(answers(), noRules);

    expect(output).toEqual({
      category: "receipt",
      importance: "medium",
      urgency: "none",
      recommendedAction: "archive",
      confidence: "high",
      needsReview: false,
      reason:
        "receipt (p=0.91) → archive (p=0.84); importance medium (2.10/4), urgency none (0.20/4)",
    });
    expect(diagnostics.reviewTriggers).toEqual([]);
    expect(diagnostics.ruleDisagreement).toBe(false);
  });

  describe("score → level rounding and clamping", () => {
    it.each([
      [0, "none"],
      [0.49, "none"],
      [0.5, "low"],
      [1.4, "low"],
      [2.5, "high"],
      [3.6, "critical"],
      [4, "critical"],
      [7.2, "critical"],
      [-1, "none"],
    ])("importance score %p → %p", (score, level) => {
      const { output } = mapJudgmentsToOutput(
        answers({ importance: score as number }),
        noRules,
      );
      expect(output.importance).toBe(level);
    });

    it.each([
      [0, "none"],
      [1, "eventually"],
      [2.2, "this_week"],
      [3, "today"],
      [3.8, "immediate"],
      [9, "immediate"],
    ])("urgency score %p → %p", (score, level) => {
      const { output } = mapJudgmentsToOutput(
        answers({ urgency: score as number }),
        noRules,
      );
      expect(output.urgency).toBe(level);
    });
  });

  describe("displayed score agrees with the level", () => {
    it.each([
      [2.499, "high", "2.50"],
      [2.494, "medium", "2.49"],
      [0.004, "none", "0.00"],
      [3.4951, "critical", "3.50"],
    ])("importance %p → %p shown as %p", (score, level, shown) => {
      const { output } = mapJudgmentsToOutput(
        answers({ importance: score as number }),
        noRules,
      );
      expect(output.importance).toBe(level);
      expect(output.reason).toContain(`importance ${level} (${shown}/4)`);
    });
  });

  describe("confidence bands use min(category, action)", () => {
    it("high at the high threshold", () => {
      const { output } = mapJudgmentsToOutput(
        answers({
          categoryConfidence: HIGH_CONFIDENCE_THRESHOLD,
          actionConfidence: 0.99,
        }),
        noRules,
      );
      expect(output.confidence).toBe("high");
    });

    it("medium when the weaker answer is between thresholds", () => {
      const { output } = mapJudgmentsToOutput(
        answers({ categoryConfidence: 0.95, actionConfidence: 0.6 }),
        noRules,
      );
      expect(output.confidence).toBe("medium");
      expect(output.needsReview).toBe(false);
    });

    it("medium exactly at the medium threshold", () => {
      const { output } = mapJudgmentsToOutput(
        answers({ categoryConfidence: MEDIUM_CONFIDENCE_THRESHOLD }),
        noRules,
      );
      expect(output.confidence).toBe("medium");
    });

    it("low below the medium threshold, which triggers review", () => {
      const { output, diagnostics } = mapJudgmentsToOutput(
        answers({ categoryConfidence: 0.3 }),
        noRules,
      );
      expect(output.confidence).toBe("low");
      expect(output.needsReview).toBe(true);
      expect(diagnostics.reviewTriggers).toEqual(["low confidence"]);
      expect(output.reason).toMatch(/review: low confidence$/);
    });
  });

  describe("needsReview triggers", () => {
    it("category unknown", () => {
      const { output, diagnostics } = mapJudgmentsToOutput(
        answers({ category: "unknown", action: "no_action" }),
        noRules,
      );
      expect(output.needsReview).toBe(true);
      expect(diagnostics.reviewTriggers).toContain("category unknown");
    });

    it("sensitive at the threshold", () => {
      const { output, diagnostics } = mapJudgmentsToOutput(
        answers({ sensitive: SENSITIVE_REVIEW_THRESHOLD }),
        noRules,
      );
      expect(output.needsReview).toBe(true);
      expect(diagnostics.reviewTriggers).toEqual(["sensitive (p=0.50)"]);
    });

    it("not sensitive just below the threshold", () => {
      const { output } = mapJudgmentsToOutput(
        answers({ sensitive: SENSITIVE_REVIEW_THRESHOLD - 0.01 }),
        noRules,
      );
      expect(output.needsReview).toBe(false);
    });

    it("high-confidence rule engine disagreeing with the chosen category", () => {
      const { output, diagnostics } = mapJudgmentsToOutput(answers(), {
        ruleCategory: "newsletter",
        ruleConfidence: "high",
      });
      expect(output.needsReview).toBe(true);
      expect(diagnostics.ruleDisagreement).toBe(true);
      expect(output.reason).toMatch(/review: rules said newsletter \(high\)/);
    });

    it("ignores rule disagreement when rule confidence is not high", () => {
      const { output } = mapJudgmentsToOutput(answers(), {
        ruleCategory: "newsletter",
        ruleConfidence: "medium",
      });
      expect(output.needsReview).toBe(false);
    });

    it("ignores a high-confidence rule category that is not an EmailCategory", () => {
      const { output, diagnostics } = mapJudgmentsToOutput(answers(), {
        ruleCategory: "shopping",
        ruleConfidence: "high",
      });
      expect(output.needsReview).toBe(false);
      expect(diagnostics.ruleDisagreement).toBe(false);
    });

    it("does not flag when the rule engine agrees", () => {
      const { output } = mapJudgmentsToOutput(answers(), {
        ruleCategory: "receipt",
        ruleConfidence: "high",
      });
      expect(output.needsReview).toBe(false);
    });

    it("lists every trigger when several fire", () => {
      const { diagnostics, output } = mapJudgmentsToOutput(
        answers({
          category: "unknown",
          categoryConfidence: 0.2,
          sensitive: 0.9,
        }),
        { ruleCategory: "receipt", ruleConfidence: "high" },
      );
      expect(diagnostics.reviewTriggers).toEqual([
        "category unknown",
        "low confidence",
        "sensitive (p=0.90)",
        "rules said receipt (high)",
      ]);
      expect(output.reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
    });
  });

  it("keeps the reason within the schema limit", () => {
    const { output } = mapJudgmentsToOutput(
      answers({ category: "unknown", categoryConfidence: 0.1, sensitive: 1 }),
      { ruleCategory: "needs_attention", ruleConfidence: "high" },
    );
    expect(output.reason.length).toBeGreaterThan(0);
    expect(output.reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
  });

  describe("invalid answers throw (treated as an invalid provider response)", () => {
    it("a label outside EmailCategorySchema", () => {
      expect(() =>
        mapJudgmentsToOutput(answers({ category: "spam" }), noRules),
      ).toThrow(/unknown category "spam"/);
    });

    it("a label outside RecommendedActionSchema", () => {
      expect(() =>
        mapJudgmentsToOutput(answers({ action: "forward_to_boss" }), noRules),
      ).toThrow(/unknown action "forward_to_boss"/);
    });

    it("a missing answer", () => {
      const a = answers();
      delete a.urgency;
      expect(() => mapJudgmentsToOutput(a, noRules)).toThrow(
        /missing answer "urgency"/,
      );
    });

    it("a non-finite score", () => {
      expect(() =>
        mapJudgmentsToOutput(answers({ urgency: Number.NaN }), noRules),
      ).toThrow(/Non-finite score/);
    });

    it("an answer of the wrong type", () => {
      const a = answers();
      a.sensitive = a.importance;
      expect(() => mapJudgmentsToOutput(a, noRules)).toThrow(/expected "noul"/);
    });
  });
});
