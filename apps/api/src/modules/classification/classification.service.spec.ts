import {
  EmailClassificationOutputSchema,
  TypeSafeResponse,
} from "@email-ai/shared";
import { DatabaseService } from "../database/database.service";
import { AiProviderService } from "../ai-provider/ai-provider.service";
import {
  AiProviderError,
  BreakerOpenError,
  InvalidProviderResponseError,
  ProviderRequestRejectedError,
} from "../ai-provider/ai-provider.error";
import type { TypeSafeJudgeResult } from "../ai-provider/providers";
import {
  ClassificationService,
  MAX_CONSECUTIVE_REJECTIONS,
} from "./classification.service";
import { CLASSIFICATION_QUESTION_SET_VERSION } from "./classification.questions";
import { REVIEW_POLICY_VERSION } from "./classification.judgments";
import { SenderRulesService } from "../sender-rules/sender-rules.service";
import {
  MatchableSenderRule,
  compileRules,
} from "../sender-rules/sender-rule-matcher";

const normalized = {
  id: "n1",
  cleanedText: "Thanks for your order. Total $42.",
  ruleCategory: "receipt",
  ruleConfidence: "high",
  ruleReasons: ["order keyword"],
  isNewsletter: false,
  isBulk: true,
  senderDomain: "shop.example",
  classification: null,
  parsedEmail: {
    subject: "Order #1234 confirmed",
    fromAddress: "orders@shop.example",
    fromName: "Shop",
  },
};

const typesafeResponse: TypeSafeResponse = {
  model: "jev-1.13.0",
  answers: {
    category: {
      type: "choice",
      choice: "receipt",
      confidence: 0.92,
      probabilities: { receipt: 0.95, marketing: 0.05 },
    },
    recommendedAction: {
      type: "choice",
      choice: "archive",
      confidence: 0.8,
      probabilities: { archive: 0.88, mark_read: 0.12 },
    },
    importance: {
      type: "score",
      score: 2.1,
      confidence: 0.7,
      probabilities: { "0": 0, "1": 0.1, "2": 0.7, "3": 0.2, "4": 0 },
    },
    urgency: {
      type: "score",
      score: 0.1,
      confidence: 0.9,
      probabilities: { "0": 0.9, "1": 0.1, "2": 0, "3": 0, "4": 0 },
    },
    sensitive: { type: "noul", noul: 0.04 },
  },
  usage: { input_tokens: 900, output_tokens: 10 },
};

/** Exact body text, including a field Zod would strip. */
const rawBody = JSON.stringify({ ...typesafeResponse, trace_id: "t-1" });

/**
 * Mirrors AiProviderService.judgeWith: runs `interpret` on the judge result
 * and rethrows interpret failures as InvalidProviderResponseError.
 */
function judgeWithFor(result: TypeSafeJudgeResult) {
  return async <T>(
    _request: unknown,
    interpret: (r: TypeSafeJudgeResult) => T,
  ): Promise<T> => {
    try {
      return interpret(result);
    } catch (error) {
      throw new InvalidProviderResponseError(
        "typesafe",
        "invalid_shape",
        `TypeSafe answers could not be interpreted: ${(error as Error).message}`,
        result.rawBody,
      );
    }
  };
}

function makeService(
  providerType: string | null,
  ids = ["n1", "n2"],
  rules: MatchableSenderRule[] = [],
) {
  const db = {
    normalizedEmail: {
      findUnique: jest.fn().mockResolvedValue(normalized),
      findMany: jest.fn().mockResolvedValue(ids.map((id) => ({ id }))),
    },
    emailClassification: {
      upsert: jest
        .fn()
        .mockImplementation((args: { create: object }) =>
          Promise.resolve({ id: "c1", ...args.create }),
        ),
    },
  };
  const ai = {
    getActiveProviderType: jest.fn().mockResolvedValue(providerType),
    judgeWith: jest
      .fn()
      .mockImplementation(
        judgeWithFor({ response: typesafeResponse, rawBody }),
      ),
    complete: jest.fn(),
    getBreakerStatus: jest.fn().mockReturnValue({ open: false }),
  };
  const senderRules = {
    getMatcher: jest.fn().mockResolvedValue(compileRules(rules)),
  };
  const service = new ClassificationService(
    db as unknown as DatabaseService,
    ai as unknown as AiProviderService,
    senderRules as unknown as SenderRulesService,
  );
  return { service, db, ai, senderRules };
}

const rejected = () =>
  new ProviderRequestRejectedError("typesafe", 422, '{"detail":"too big"}');

const invalidShape = () =>
  new InvalidProviderResponseError(
    "typesafe",
    "invalid_shape",
    "TypeSafe response failed validation: answers.category.confidence: Required",
    '{"model":"jev","answers":{}}',
  );

const unparseable = () =>
  new InvalidProviderResponseError(
    "typesafe",
    "unparseable",
    "TypeSafe response is not valid JSON: <html>proxy</html>",
    "<html>proxy</html>",
  );

describe("ClassificationService — TypeSafe path", () => {
  it("judges and upserts the mapped values with providerUsed typesafe", async () => {
    const { service, db, ai } = makeService("typesafe");

    await service.classifyEmail("n1");

    expect(ai.complete).not.toHaveBeenCalled();
    expect(ai.judgeWith).toHaveBeenCalledTimes(1);
    const req = ai.judgeWith.mock.calls[0][0];
    expect(req.state.email.subject).toBe("Order #1234 confirmed");
    expect(Object.keys(req.questions)).toHaveLength(5);

    const { create, update } = db.emailClassification.upsert.mock.calls[0][0];
    expect(create).toMatchObject({
      normalizedEmailId: "n1",
      category: "receipt",
      importance: "medium",
      urgency: "none",
      recommendedAction: "archive",
      confidence: "high",
      needsReview: false,
      providerUsed: "typesafe",
      classificationError: null,
    });
    expect(create.reason).toMatch(/^receipt \(p=0\.95\) → archive/);
    expect(update).toMatchObject({ providerUsed: "typesafe" });
  });

  it("stores an audit envelope with the question-set version and the exact raw body", async () => {
    const { service, db } = makeService("typesafe");

    await service.classifyEmail("n1");

    const { create } = db.emailClassification.upsert.mock.calls[0][0];
    expect(JSON.parse(create.rawResponse)).toEqual({
      questionSetVersion: CLASSIFICATION_QUESTION_SET_VERSION,
      reviewPolicyVersion: REVIEW_POLICY_VERSION,
      model: "jev-1.13.0",
      raw: rawBody,
    });
  });

  it("unmappable answers propagate as InvalidProviderResponseError and write nothing", async () => {
    const { service, db, ai } = makeService("typesafe");
    const bad: TypeSafeResponse = {
      ...typesafeResponse,
      answers: {
        ...typesafeResponse.answers,
        category: {
          type: "choice",
          choice: "spam",
          confidence: 0.9,
          probabilities: { spam: 1 },
        },
      },
    };
    ai.judgeWith.mockImplementation(
      judgeWithFor({ response: bad, rawBody: JSON.stringify(bad) }),
    );

    await expect(service.classifyEmail("n1")).rejects.toThrow(
      /unknown category "spam"/,
    );
    await expect(service.classifyEmail("n1")).rejects.toBeInstanceOf(
      InvalidProviderResponseError,
    );
    expect(db.emailClassification.upsert).not.toHaveBeenCalled();
  });

  it.each([[invalidShape()], [unparseable()]])(
    "an unusable response (%s) propagates and writes nothing (never a fallback row)",
    async (err) => {
      const { service, db, ai } = makeService("typesafe");
      ai.judgeWith.mockRejectedValue(err);

      await expect(service.classifyEmail("n1")).rejects.toBe(err);
      expect(db.emailClassification.upsert).not.toHaveBeenCalled();
    },
  );

  it("a provider error propagates and writes nothing", async () => {
    const { service, db, ai } = makeService("typesafe");
    ai.judgeWith.mockRejectedValue(
      new AiProviderError({ provider: "typesafe", status: 529 }),
    );

    await expect(service.classifyEmail("n1")).rejects.toBeInstanceOf(
      AiProviderError,
    );
    expect(db.emailClassification.upsert).not.toHaveBeenCalled();
  });

  it("BreakerOpenError propagates, and processUnclassified defers the batch", async () => {
    const { service, db, ai } = makeService("typesafe");
    ai.judgeWith.mockRejectedValue(
      new BreakerOpenError("2026-09-23T00:00:00Z"),
    );

    await expect(service.classifyEmail("n1")).rejects.toBeInstanceOf(
      BreakerOpenError,
    );

    const result = await service.processUnclassified();
    expect(result).toEqual({
      processed: 0,
      errors: 0,
      needsReview: 0,
      skipped: 2,
      ruleClassified: 0,
    });
    // Broke out after the first email rather than trying the second.
    expect(ai.judgeWith).toHaveBeenCalledTimes(2); // 1 direct + 1 in batch
    expect(db.emailClassification.upsert).not.toHaveBeenCalled();
  });
});

describe("ClassificationService — batch ordering", () => {
  it("queries unclassified emails in a deterministic order (newest first, then id)", async () => {
    const { service, db } = makeService("typesafe");

    await service.processUnclassified();

    expect(db.normalizedEmail.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { parsedEmail: { rawEmail: { internalDate: "desc" } } },
          { id: "desc" },
        ],
      }),
    );
  });
});

describe("ClassificationService — per-email invalid shapes", () => {
  it("counts one invalid-shape email as an error, writes no row for it, and continues", async () => {
    const { service, db, ai } = makeService("typesafe", ["n1", "n2", "n3"]);
    const ok = judgeWithFor({ response: typesafeResponse, rawBody });
    ai.judgeWith.mockRejectedValueOnce(invalidShape()).mockImplementation(ok);

    const result = await service.processUnclassified();

    expect(result).toEqual({
      processed: 2,
      errors: 1,
      needsReview: 0,
      skipped: 0,
      ruleClassified: 0,
    });
    expect(ai.judgeWith).toHaveBeenCalledTimes(3);
    expect(db.emailClassification.upsert).toHaveBeenCalledTimes(2);
  });

  it("an unparseable body is systemic: the breaker it opened stops the batch", async () => {
    const { service, db, ai } = makeService("typesafe", ["n1", "n2", "n3"]);
    // AiProviderService records `unparseable` as a breaker failure, so the
    // next email short-circuits with BreakerOpenError.
    ai.judgeWith
      .mockRejectedValueOnce(unparseable())
      .mockRejectedValue(new BreakerOpenError("2026-09-22T12:01:00Z"));

    const result = await service.processUnclassified();

    expect(result).toEqual({
      processed: 0,
      errors: 1,
      needsReview: 0,
      skipped: 2,
      ruleClassified: 0,
    });
    expect(ai.judgeWith).toHaveBeenCalledTimes(2);
    expect(db.emailClassification.upsert).not.toHaveBeenCalled();
  });

  it(`stops after ${MAX_CONSECUTIVE_REJECTIONS} consecutive mixed 422 / invalid-shape failures`, async () => {
    const ids = ["n1", "n2", "n3", "n4", "n5"];
    const { service, db, ai } = makeService("typesafe", ids);
    ai.judgeWith
      .mockRejectedValueOnce(invalidShape())
      .mockRejectedValueOnce(rejected())
      .mockRejectedValueOnce(invalidShape())
      .mockImplementation(
        judgeWithFor({ response: typesafeResponse, rawBody }),
      );

    const result = await service.processUnclassified();

    expect(result).toEqual({
      processed: 0,
      errors: MAX_CONSECUTIVE_REJECTIONS,
      needsReview: 0,
      skipped: ids.length - MAX_CONSECUTIVE_REJECTIONS,
      ruleClassified: 0,
    });
    expect(ai.judgeWith).toHaveBeenCalledTimes(MAX_CONSECUTIVE_REJECTIONS);
    expect(db.emailClassification.upsert).not.toHaveBeenCalled();
  });
});

describe("ClassificationService — per-email rejections (422)", () => {
  it("counts a rejection as an error, writes no row for it, and continues", async () => {
    const { service, db, ai } = makeService("typesafe", ["n1", "n2", "n3"]);
    const ok = judgeWithFor({ response: typesafeResponse, rawBody });
    ai.judgeWith.mockRejectedValueOnce(rejected()).mockImplementation(ok);

    const result = await service.processUnclassified();

    expect(result).toEqual({
      processed: 2,
      errors: 1,
      needsReview: 0,
      skipped: 0,
      ruleClassified: 0,
    });
    expect(ai.judgeWith).toHaveBeenCalledTimes(3);
    expect(db.emailClassification.upsert).toHaveBeenCalledTimes(2);
  });

  it(`stops after ${MAX_CONSECUTIVE_REJECTIONS} consecutive rejections and defers the rest`, async () => {
    const ids = ["n1", "n2", "n3", "n4", "n5"];
    const { service, db, ai } = makeService("typesafe", ids);
    ai.judgeWith.mockRejectedValue(rejected());

    const result = await service.processUnclassified();

    expect(result).toEqual({
      processed: 0,
      errors: MAX_CONSECUTIVE_REJECTIONS,
      needsReview: 0,
      skipped: ids.length - MAX_CONSECUTIVE_REJECTIONS,
      ruleClassified: 0,
    });
    expect(ai.judgeWith).toHaveBeenCalledTimes(MAX_CONSECUTIVE_REJECTIONS);
    expect(db.emailClassification.upsert).not.toHaveBeenCalled();
  });

  it("a success resets the consecutive-rejection count", async () => {
    const ids = ["n1", "n2", "n3", "n4", "n5"];
    const { service, ai } = makeService("typesafe", ids);
    const ok = judgeWithFor({ response: typesafeResponse, rawBody });
    ai.judgeWith
      .mockRejectedValueOnce(rejected())
      .mockRejectedValueOnce(rejected())
      .mockImplementationOnce(ok)
      .mockRejectedValueOnce(rejected())
      .mockRejectedValueOnce(rejected());

    const result = await service.processUnclassified();

    expect(result).toEqual({
      processed: 1,
      errors: 4,
      needsReview: 0,
      skipped: 0,
      ruleClassified: 0,
    });
    expect(ai.judgeWith).toHaveBeenCalledTimes(5);
  });
});

describe("ClassificationService — LLM path", () => {
  it("non-typesafe providers use complete() and store the provider name", async () => {
    const { service, db, ai } = makeService("openai");
    ai.complete.mockResolvedValue({
      content: JSON.stringify({
        category: "receipt",
        importance: "medium",
        urgency: "none",
        recommendedAction: "archive",
        confidence: "high",
        needsReview: false,
        reason: "Order confirmation",
      }),
    });

    await service.classifyEmail("n1");

    expect(ai.judgeWith).not.toHaveBeenCalled();
    expect(ai.complete).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.3 }),
    );
    const { create } = db.emailClassification.upsert.mock.calls[0][0];
    expect(create).toMatchObject({
      category: "receipt",
      providerUsed: "openai",
      reason: "Order confirmation",
      classificationError: null,
    });
  });

  it("an unparseable completion → fallback row", async () => {
    const { service, db, ai } = makeService("openai");
    ai.complete.mockResolvedValue({ content: "not json" });

    await service.classifyEmail("n1");

    const { create } = db.emailClassification.upsert.mock.calls[0][0];
    expect(create).toMatchObject({
      category: "unknown",
      providerUsed: "fallback",
      rawResponse: "not json",
    });
  });

  it("returns an existing classification without calling any provider", async () => {
    const { service, db, ai } = makeService("typesafe");
    const existing = { id: "c0", category: "personal" };
    db.normalizedEmail.findUnique.mockResolvedValue({
      ...normalized,
      classification: existing,
    });

    await expect(service.classifyEmail("n1")).resolves.toBe(existing);
    expect(ai.judgeWith).not.toHaveBeenCalled();
    expect(ai.complete).not.toHaveBeenCalled();
  });
});

describe("ClassificationService — sender rules", () => {
  const promoRule: MatchableSenderRule = {
    id: "rule-promo",
    pattern: "news.*.com",
    matchType: "glob",
    category: "marketing",
    action: "classify",
    createdAt: new Date("2026-09-01T00:00:00Z"),
  };

  const promoEmail = {
    ...normalized,
    id: "n-promo",
    senderDomain: "news.getthefinnewsnow.com",
    parsedEmail: {
      ...normalized.parsedEmail,
      fromAddress: "reply@news.getthefinnewsnow.com",
    },
  };

  /** Batch rows as the widened processUnclassified select returns them. */
  const candidate = (e: typeof normalized) => ({
    id: e.id,
    senderDomain: e.senderDomain,
    parsedEmail: { fromAddress: e.parsedEmail.fromAddress },
  });

  it("a rule match writes a sender-rule row without touching the AI provider", async () => {
    const { service, db, ai } = makeService("typesafe", [], [promoRule]);
    db.normalizedEmail.findUnique.mockResolvedValue(promoEmail);

    await service.classifyEmail("n-promo");

    expect(ai.getActiveProviderType).not.toHaveBeenCalled();
    expect(ai.judgeWith).not.toHaveBeenCalled();
    expect(ai.complete).not.toHaveBeenCalled();
    const { create, update } = db.emailClassification.upsert.mock.calls[0][0];
    expect(create).toEqual({
      normalizedEmailId: "n-promo",
      category: "marketing",
      importance: "low",
      urgency: "none",
      recommendedAction: "unsubscribe",
      confidence: "high",
      needsReview: false,
      reason: 'Sender rule rule-promo: glob "news.*.com"',
      rawResponse: JSON.stringify({
        ruleId: "rule-promo",
        matchType: "glob",
        pattern: "news.*.com",
        matchedOn: "domain",
      }),
      classificationError: null,
      providerUsed: "sender-rule",
      senderRuleId: "rule-promo",
    });
    expect(update).toMatchObject({
      providerUsed: "sender-rule",
      senderRuleId: "rule-promo",
    });
    expect(
      EmailClassificationOutputSchema.safeParse(create).success,
    ).toBe(true);
  });

  it.each([
    ["delete", "delete"],
    ["archive", "archive"],
    ["marketing", "unsubscribe"],
    ["newsletter", "mark_read"],
    ["receipt", "mark_read"],
  ])("maps rule category %s to recommendedAction %s", async (category, action) => {
    const { service, db } = makeService("typesafe", [], [
      { ...promoRule, category },
    ]);
    db.normalizedEmail.findUnique.mockResolvedValue(promoEmail);

    await service.classifyEmail("n-promo");

    const { create } = db.emailClassification.upsert.mock.calls[0][0];
    expect(create).toMatchObject({ category, recommendedAction: action });
  });

  it("a non-matching email goes down the AI path unchanged (senderRuleId null)", async () => {
    const { service, db, ai } = makeService("typesafe", [], [promoRule]);

    await service.classifyEmail("n1");

    expect(ai.getActiveProviderType).toHaveBeenCalledTimes(1);
    expect(ai.judgeWith).toHaveBeenCalledTimes(1);
    const { create } = db.emailClassification.upsert.mock.calls[0][0];
    expect(create).toMatchObject({
      providerUsed: "typesafe",
      senderRuleId: null,
    });
  });

  it("uses a matcher passed by the caller instead of loading one", async () => {
    const { service, db, senderRules } = makeService("typesafe", [], []);
    db.normalizedEmail.findUnique.mockResolvedValue(promoEmail);

    await service.classifyEmail("n-promo", compileRules([promoRule]));

    expect(senderRules.getMatcher).not.toHaveBeenCalled();
    const { create } = db.emailClassification.upsert.mock.calls[0][0];
    expect(create.providerUsed).toBe("sender-rule");
  });

  it("classifies rule matches even when the breaker is open, and defers the rest", async () => {
    const { service, db, ai, senderRules } = makeService(
      "typesafe",
      [],
      [promoRule],
    );
    db.normalizedEmail.findMany.mockResolvedValue([
      candidate(normalized),
      candidate(promoEmail),
    ]);
    db.normalizedEmail.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === "n-promo" ? promoEmail : normalized),
    );
    ai.getBreakerStatus.mockReturnValue({
      open: true,
      nextAllowedAttempt: "2026-09-24T00:00:00Z",
      reason: "quota",
    });

    const result = await service.processUnclassified();

    expect(result).toEqual({
      processed: 1,
      errors: 0,
      needsReview: 0,
      skipped: 1,
      ruleClassified: 1,
    });
    expect(senderRules.getMatcher).toHaveBeenCalledTimes(1);
    expect(ai.getActiveProviderType).not.toHaveBeenCalled();
    expect(ai.judgeWith).not.toHaveBeenCalled();
    expect(db.emailClassification.upsert).toHaveBeenCalledTimes(1);
    expect(
      db.emailClassification.upsert.mock.calls[0][0].create.providerUsed,
    ).toBe("sender-rule");
  });

  it("runs the rule pass first, then the AI loop over non-matches only", async () => {
    const { service, db, ai } = makeService("typesafe", [], [promoRule]);
    db.normalizedEmail.findMany.mockResolvedValue([
      candidate(normalized),
      candidate(promoEmail),
    ]);
    db.normalizedEmail.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === "n-promo" ? promoEmail : normalized),
    );

    const result = await service.processUnclassified();

    expect(result).toEqual({
      processed: 2,
      errors: 0,
      needsReview: 0,
      skipped: 0,
      ruleClassified: 1,
    });
    expect(ai.judgeWith).toHaveBeenCalledTimes(1);
    const ids = db.emailClassification.upsert.mock.calls.map(
      (c: [{ where: { normalizedEmailId: string } }]) =>
        c[0].where.normalizedEmailId,
    );
    // Rule pass before the AI loop, even though n1 is first in the batch.
    expect(ids).toEqual(["n-promo", "n1"]);
  });

  it("a failed rule write counts under errors and the rest of the batch continues", async () => {
    const { service, db, ai } = makeService("typesafe", [], [promoRule]);
    db.normalizedEmail.findMany.mockResolvedValue([
      candidate(promoEmail),
      candidate(normalized),
    ]);
    db.emailClassification.upsert.mockRejectedValueOnce(
      new Error("connection reset"),
    );

    const result = await service.processUnclassified();

    expect(result).toEqual({
      processed: 1,
      errors: 1,
      needsReview: 0,
      skipped: 0,
      ruleClassified: 0,
    });
    // The failed rule email is not retried through the AI loop this run.
    expect(ai.judgeWith).toHaveBeenCalledTimes(1);
  });

  it("a rule with an invalid stored category falls through to AI", async () => {
    const { service, db, ai } = makeService("typesafe", [], [
      { ...promoRule, category: "not-a-category" },
    ]);
    db.normalizedEmail.findMany.mockResolvedValue([candidate(promoEmail)]);
    db.normalizedEmail.findUnique.mockResolvedValue(promoEmail);

    const result = await service.processUnclassified();

    expect(result).toEqual({
      processed: 1,
      errors: 0,
      needsReview: 0,
      skipped: 0,
      ruleClassified: 0,
    });
    expect(ai.judgeWith).toHaveBeenCalledTimes(1);
    const { create } = db.emailClassification.upsert.mock.calls[0][0];
    expect(create).toMatchObject({ providerUsed: "typesafe", senderRuleId: null });
  });

  it("selects the sender fields the rule pass needs", async () => {
    const { service, db } = makeService("typesafe");

    await service.processUnclassified();

    expect(db.normalizedEmail.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          senderDomain: true,
          parsedEmail: { select: { fromAddress: true } },
        },
      }),
    );
  });
});

describe("ClassificationService — getStats", () => {
  it("counts sender-rule rows under ruleClassified, not aiClassified", async () => {
    const { service, db } = makeService("typesafe");
    (db.emailClassification as Record<string, jest.Mock>).findMany = jest
      .fn()
      .mockResolvedValue([
        { providerUsed: "typesafe", category: "receipt", needsReview: false },
        { providerUsed: "openai", category: "personal", needsReview: true },
        { providerUsed: "sender-rule", category: "marketing", needsReview: false },
        { providerUsed: "sender-rule", category: "delete", needsReview: false },
        { providerUsed: "fallback", category: "unknown", needsReview: true },
        { providerUsed: null, category: "unknown", needsReview: false },
      ]);

    const stats = await service.getStats();

    expect(stats).toMatchObject({
      total: 6,
      aiClassified: 2,
      ruleClassified: 2,
      fallbackClassified: 1,
      needsReview: 2,
    });
    expect(stats.byProvider["sender-rule"]).toBe(2);
  });
});
