import { DatabaseService } from "../database/database.service";
import { ACTIONABLE_WHERE, ReviewQueueService } from "./review-queue.service";
import {
  DEFAULT_REVIEW_WINDOW_DAYS,
  windowStartForDays,
} from "./review-window";

const REVIEW_WHERE = {
  OR: [
    { needsReview: true },
    { confidence: { in: ["low", "medium"] } },
  ],
  reviewDecision: null,
};

function receivedSince(since: Date) {
  return {
    normalizedEmail: {
      parsedEmail: { rawEmail: { internalDate: { gte: since } } },
    },
  };
}

function makeService() {
  const db = {
    emailClassification: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const service = new ReviewQueueService(db as unknown as DatabaseService);
  return { service, db };
}

describe("ReviewQueueService received-date window", () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: new Date(2026, 8, 23, 15, 30) });
  });
  afterAll(() => jest.useRealTimers());

  const defaultSince = () => new Date(2026, 8, 9); // local midnight, 14 days back

  it("defaults to a 14-day window measured to local midnight", () => {
    expect(DEFAULT_REVIEW_WINDOW_DAYS).toBe(14);
    expect(windowStartForDays(14)).toEqual(defaultSince());
  });

  it("ANDs the default window onto the review filter", async () => {
    const { service, db } = makeService();

    const res = await service.getReviewQueue(1, 20);

    const expected = {
      AND: [REVIEW_WHERE, receivedSince(defaultSince())],
    };
    expect(db.emailClassification.findMany.mock.calls[0][0].where).toEqual(
      expected,
    );
    expect(db.emailClassification.count).toHaveBeenCalledWith({
      where: expected,
    });
    expect(res.window).toEqual({
      since: defaultSince().toISOString(),
      days: 14,
    });
  });

  it("ANDs the default window onto ACTIONABLE_WHERE", async () => {
    const { service, db } = makeService();

    await service.getActionableQueue(1, 20);

    expect(db.emailClassification.findMany.mock.calls[0][0].where).toEqual({
      AND: [ACTIONABLE_WHERE, receivedSince(defaultSince())],
    });
  });

  it("preserves the confidence threshold alongside the window", async () => {
    const { service, db } = makeService();
    const since = new Date(2026, 0, 1);

    await service.getReviewQueue(1, 20, "high", { since, days: null });

    expect(db.emailClassification.findMany.mock.calls[0][0].where).toEqual({
      AND: [
        {
          ...REVIEW_WHERE,
          OR: [
            { needsReview: true },
            { confidence: { in: ["low", "medium", "high"] } },
          ],
        },
        receivedSince(since),
      ],
    });
  });

  it("drops only the date filter when the window is disabled", async () => {
    const { service, db } = makeService();

    const review = await service.getReviewQueue(1, 20, undefined, {
      since: null,
      days: null,
    });
    await service.getActionableQueue(1, 20, { since: null, days: null });

    expect(db.emailClassification.findMany.mock.calls[0][0].where).toEqual(
      REVIEW_WHERE,
    );
    expect(db.emailClassification.findMany.mock.calls[1][0].where).toEqual(
      ACTIONABLE_WHERE,
    );
    expect(review.window).toEqual({ since: null, days: null });
  });

  it("keeps pagination fields in the response", async () => {
    const { service, db } = makeService();
    db.emailClassification.count.mockResolvedValue(45);

    const res = await service.getReviewQueue(2, 20);

    expect(res.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 45,
      totalPages: 3,
    });
    expect(db.emailClassification.findMany.mock.calls[0][0]).toMatchObject({
      skip: 20,
      take: 20,
    });
  });

  it("getNextPendingId follows the given window", async () => {
    const { service, db } = makeService();

    await service.getNextPendingId({ since: null, days: null });
    await service.getNextPendingId();

    expect(db.emailClassification.findMany.mock.calls[0][0]).toMatchObject({
      where: REVIEW_WHERE,
      take: 1,
    });
    expect(db.emailClassification.findMany.mock.calls[1][0].where).toEqual({
      AND: [REVIEW_WHERE, receivedSince(defaultSince())],
    });
  });
});

describe("ReviewQueueService human decisions replace auto approvals (EMAIL-6)", () => {
  function makeDecisionService(existing: { source: "human" | "auto" } | null) {
    const created = (data: Record<string, unknown>) => ({
      id: "rd1",
      decidedAt: new Date(),
      correctedCategory: null,
      ...data,
    });
    const db = {
      emailClassification: {
        findUnique: jest.fn().mockResolvedValue({
          id: "c1",
          reviewDecision: existing ? { id: "rd0", decision: "approved", ...existing } : null,
        }),
      },
      reviewDecision: {
        delete: jest.fn().mockResolvedValue({}),
        create: jest.fn(async ({ data }) => created(data)),
        upsert: jest.fn(async ({ create }) => created(create)),
      },
    };
    const service = new ReviewQueueService(db as unknown as DatabaseService);
    return { service, db };
  }

  it("approve replaces an auto approval with a human one (single upsert)", async () => {
    const { service, db } = makeDecisionService({ source: "auto" });
    const res = await service.approveClassification("c1");
    expect(db.reviewDecision.delete).not.toHaveBeenCalled();
    expect(db.reviewDecision.create).not.toHaveBeenCalled();
    const args = db.reviewDecision.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ classificationId: "c1" });
    expect(args.update).toMatchObject({
      decision: "approved",
      correctedCategory: null,
      source: "human",
    });
    expect(args.update.decidedAt).toBeInstanceOf(Date);
    expect(args.create).toMatchObject({ classificationId: "c1", source: "human" });
    expect(res.source).toBe("human");
  });

  it("reject replaces an auto approval with a human rejection", async () => {
    const { service, db } = makeDecisionService({ source: "auto" });
    await service.rejectClassification("c1", "personal");
    expect(db.reviewDecision.delete).not.toHaveBeenCalled();
    const args = db.reviewDecision.upsert.mock.calls[0][0];
    expect(args.update).toMatchObject({
      decision: "rejected",
      correctedCategory: "personal",
      source: "human",
    });
  });

  it("recategorize overwrites an auto approval as human, re-timestamped", async () => {
    const { service, db } = makeDecisionService({ source: "auto" });
    await service.recategorizeClassification("c1", "personal");
    const args = db.reviewDecision.upsert.mock.calls[0][0];
    expect(args.create).toMatchObject({ source: "human", decision: "rejected" });
    expect(args.update).toMatchObject({
      source: "human",
      decision: "rejected",
      correctedCategory: "personal",
    });
    expect(args.update.decidedAt).toBeInstanceOf(Date);
  });

  it("an undecided row gets a human decision", async () => {
    const { service, db } = makeDecisionService(null);
    await service.approveClassification("c1");
    expect(db.reviewDecision.delete).not.toHaveBeenCalled();
    expect(db.reviewDecision.upsert.mock.calls[0][0].create.source).toBe("human");
  });
});
