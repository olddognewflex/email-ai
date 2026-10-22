import { ConflictException, INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ClientHeaderGuard } from "../../common/client-header";
import { AppConfigService } from "../config/config.service";
import { DatabaseService } from "../database/database.service";
import { AutoApproveController, parseLimit } from "./auto-approve.controller";
import {
  AutoApproveService,
  isAutoApproveEligible,
} from "./auto-approve.service";

const DEFAULT_CATEGORIES = ["newsletter", "marketing", "archive", "receipt"];

function makeService(
  opts: { enabled?: boolean; categories?: string[]; existing?: Record<string, "human" | "auto"> } = {},
) {
  // classificationId -> decision source (the unique key on ReviewDecision)
  const decisions = new Map(Object.entries(opts.existing ?? {}));
  const db = {
    reviewDecision: {
      createMany: jest.fn(
        async ({ data }: { data: { classificationId: string; source: "human" | "auto" }[]; skipDuplicates?: boolean }) => {
          let count = 0;
          for (const d of data) {
            if (decisions.has(d.classificationId)) continue; // ON CONFLICT DO NOTHING
            decisions.set(d.classificationId, d.source);
            count++;
          }
          return { count };
        },
      ),
      deleteMany: jest.fn(async ({ where }: { where: { classificationId: string; source: string } }) => {
        if (decisions.get(where.classificationId) !== where.source) return { count: 0 };
        decisions.delete(where.classificationId);
        return { count: 1 };
      }),
    },
    emailClassification: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const config = {
    autoApproveEnabled: opts.enabled ?? true,
    autoApproveCategories: opts.categories ?? DEFAULT_CATEGORIES,
  };
  const service = new AutoApproveService(
    db as unknown as DatabaseService,
    config as unknown as AppConfigService,
  );
  return { service, db, decisions, config };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
});

describe("isAutoApproveEligible", () => {
  const confidences = ["high", "medium", "low"] as const;
  const cases: [string, string, boolean][] = [];
  for (const category of ["newsletter", "receipt", "personal", "unknown"]) {
    for (const confidence of confidences) {
      cases.push([
        category,
        confidence,
        DEFAULT_CATEGORIES.includes(category) && confidence === "high",
      ]);
    }
  }

  it.each(cases)("%s / %s -> %p", (category, confidence, expected) => {
    expect(isAutoApproveEligible({ category, confidence }, DEFAULT_CATEGORIES)).toBe(expected);
  });
});

describe("AutoApproveService.applyIfEligible", () => {
  // Eligibility matrix: category in/out x confidence x needsReview x
  // existing decision. needsReview must never matter.
  const matrix: {
    category: string;
    confidence: string;
    needsReview: boolean;
    existing: "human" | "auto" | null;
    approved: boolean;
  }[] = [];
  for (const category of ["marketing", "personal"]) {
    for (const confidence of ["high", "medium", "low"]) {
      for (const needsReview of [true, false]) {
        for (const existing of [null, "human", "auto"] as const) {
          matrix.push({
            category,
            confidence,
            needsReview,
            existing,
            approved: category === "marketing" && confidence === "high" && existing === null,
          });
        }
      }
    }
  }

  it.each(matrix)(
    "$category / $confidence / needsReview=$needsReview / existing=$existing -> approved=$approved",
    async ({ category, confidence, needsReview, existing, approved }) => {
      const { service, decisions } = makeService({
        existing: existing ? { c1: existing } : {},
      });

      const row = { id: "c1", category, confidence, needsReview };
      expect(await service.applyIfEligible(row)).toBe(approved);
      // An existing decision is never replaced; otherwise only eligible
      // rows get one.
      expect(decisions.get("c1")).toBe(existing ?? (approved ? "auto" : undefined));
    },
  );

  it("never writes while the switch is off", async () => {
    const { service, db } = makeService({ enabled: false });
    expect(await service.applyIfEligible({ id: "c1", category: "newsletter", confidence: "high" })).toBe(false);
    expect(db.reviewDecision.createMany).not.toHaveBeenCalled();
  });

  it("writes an approved, source=auto decision with skipDuplicates", async () => {
    const { service, db } = makeService();
    await service.applyIfEligible({ id: "c1", category: "receipt", confidence: "high" });
    expect(db.reviewDecision.createMany).toHaveBeenCalledWith({
      data: [{ classificationId: "c1", decision: "approved", source: "auto" }],
      skipDuplicates: true,
    });
  });
});

describe("AutoApproveService.reconcile", () => {
  const eligible = { id: "c1", category: "newsletter", confidence: "high" };
  const ineligible = { id: "c1", category: "personal", confidence: "high" };

  it("keeps an auto approval while still eligible", async () => {
    const { service, db, decisions } = makeService({ existing: { c1: "auto" } });
    expect(await service.reconcile(db as never, eligible, "auto")).toBe("kept");
    expect(decisions.get("c1")).toBe("auto");
  });

  it("removes an auto approval once ineligible", async () => {
    const { service, db, decisions } = makeService({ existing: { c1: "auto" } });
    expect(await service.reconcile(db as never, ineligible, "auto")).toBe("removed");
    expect(decisions.has("c1")).toBe(false);
    expect(db.reviewDecision.deleteMany).toHaveBeenCalledWith({
      where: { classificationId: "c1", source: "auto" },
    });
  });

  it("removes an auto approval when the write flags the row for review", async () => {
    const { service, db, decisions } = makeService({ existing: { c1: "auto" } });
    expect(await service.reconcile(db as never, eligible, "auto", { flagForReview: true })).toBe("removed");
    expect(decisions.has("c1")).toBe(false);
  });

  it("creates one for an undecided eligible row, unless flagged for review", async () => {
    const a = makeService();
    expect(await a.service.reconcile(a.db as never, eligible, null)).toBe("created");
    expect(a.decisions.get("c1")).toBe("auto");

    const b = makeService();
    expect(await b.service.reconcile(b.db as never, eligible, null, { flagForReview: true })).toBe("none");
    expect(b.decisions.has("c1")).toBe(false);
  });

  it("the delete is scoped to source=auto, so a human decision is never removed", async () => {
    const { service, db, decisions } = makeService({ existing: { c1: "human" } });
    // Even if a caller passed a stale "auto", the scoped delete is a no-op.
    await service.reconcile(db as never, ineligible, "auto");
    expect(decisions.get("c1")).toBe("human");
  });
});

describe("AutoApproveService.backfill", () => {
  const rows = [
    { id: "c1", category: "newsletter", normalizedEmail: { parsedEmail: { subject: "S1", fromAddress: "a@x" } } },
    { id: "c2", category: "marketing", normalizedEmail: { parsedEmail: { subject: "S2", fromAddress: "b@x" } } },
    { id: "c3", category: "newsletter", normalizedEmail: { parsedEmail: null } },
  ];

  function withRows(opts: Parameters<typeof makeService>[0] = {}, eligible = 5) {
    const fx = makeService(opts);
    fx.db.emailClassification.count.mockResolvedValue(eligible);
    fx.db.emailClassification.findMany.mockImplementation(async ({ take }: { take: number }) => rows.slice(0, take));
    return fx;
  }

  it("selects queued (needsReview), pending, high-confidence rows in the listed categories", async () => {
    const { service, db } = withRows();
    await service.backfill({ dryRun: true, limit: 500 });
    const where = {
      needsReview: true,
      reviewDecision: null,
      confidence: "high",
      category: { in: DEFAULT_CATEGORIES },
    };
    expect(db.emailClassification.count).toHaveBeenCalledWith({ where });
    expect(db.emailClassification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where, take: 500 }),
    );
  });

  it("dry run: reports counts and a sample, writes nothing", async () => {
    const { service, db } = withRows();
    const res = await service.backfill({ dryRun: true, limit: 500 });
    expect(res).toMatchObject({
      dryRun: true,
      enabled: true,
      eligible: 5,
      selected: 3,
      approved: 0,
      more: true,
      byCategory: { newsletter: 2, marketing: 1 },
    });
    expect(res.sample).toEqual([
      { classificationId: "c1", category: "newsletter", subject: "S1", fromAddress: "a@x" },
      { classificationId: "c2", category: "marketing", subject: "S2", fromAddress: "b@x" },
      { classificationId: "c3", category: "newsletter", subject: null, fromAddress: null },
    ]);
    expect(db.reviewDecision.createMany).not.toHaveBeenCalled();
  });

  it("real run: writes auto approvals insert-if-absent and counts only new ones", async () => {
    // c2 got a human decision after the read: left alone, not counted.
    const { service, db, decisions } = withRows({ existing: { c2: "human" } }, 3);
    const res = await service.backfill({ dryRun: false, limit: 500 });
    expect(db.reviewDecision.createMany).toHaveBeenCalledWith({
      data: ["c1", "c2", "c3"].map((id) => ({ classificationId: id, decision: "approved", source: "auto" })),
      skipDuplicates: true,
    });
    expect(res).toMatchObject({ dryRun: false, approved: 2, selected: 3, more: false });
    expect(decisions.get("c2")).toBe("human");
    expect(decisions.get("c1")).toBe("auto");
  });

  it("respects limit and reports more", async () => {
    const { service } = withRows({}, 3);
    const res = await service.backfill({ dryRun: true, limit: 2 });
    expect(res).toMatchObject({ selected: 2, eligible: 3, more: true, limit: 2 });
  });

  it("switch off: a real run is refused with 409 and writes nothing", async () => {
    const { service, db } = withRows({ enabled: false });
    await expect(service.backfill({ dryRun: false, limit: 500 })).rejects.toBeInstanceOf(ConflictException);
    expect(db.reviewDecision.createMany).not.toHaveBeenCalled();
    expect(db.emailClassification.findMany).not.toHaveBeenCalled();
  });

  it("switch off: a dry run still previews, flagged with a note", async () => {
    const { service, db } = withRows({ enabled: false });
    const res = await service.backfill({ dryRun: true, limit: 500 });
    expect(res).toMatchObject({ enabled: false, approved: 0, selected: 3 });
    expect(res.note).toMatch(/disabled/);
    expect(db.reviewDecision.createMany).not.toHaveBeenCalled();
  });
});

describe("parseLimit", () => {
  it.each([
    [undefined, 500],
    ["", 500],
    ["1", 1],
    ["5000", 5000],
  ])("%p -> %p", (raw, expected) => {
    expect(parseLimit(raw)).toBe(expected);
  });

  it.each(["0", "-1", "abc", "1.5", "5001"])("rejects %p", (raw) => {
    expect(() => parseLimit(raw)).toThrow();
  });
});

describe("POST /review/auto-approve (HTTP)", () => {
  let app: INestApplication;
  const autoApprove = { backfill: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AutoApproveController],
      providers: [{ provide: AutoApproveService, useValue: autoApprove }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalGuards(new ClientHeaderGuard());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    autoApprove.backfill.mockReset().mockResolvedValue({ dryRun: true });
  });

  const post = (url: string) =>
    request(app.getHttpServer()).post(url).set("X-Email-AI-Client", "test");

  it("403s without the X-Email-AI-Client header", async () => {
    await request(app.getHttpServer()).post("/review/auto-approve").expect(403);
    expect(autoApprove.backfill).not.toHaveBeenCalled();
  });

  it("is a dry run with limit 500 by default", async () => {
    const res = await post("/review/auto-approve").expect(200);
    expect(autoApprove.backfill).toHaveBeenCalledWith({ dryRun: true, limit: 500 });
    expect(res.body).toEqual({ success: true, data: { dryRun: true } });
  });

  it("is a dry run unless dryRun is exactly false", async () => {
    await post("/review/auto-approve?dryRun=no").expect(200);
    await post("/review/auto-approve?dryRun=FALSE").expect(200);
    await post("/review/auto-approve?dryRun=false&limit=20").expect(200);
    expect(autoApprove.backfill.mock.calls.map((c) => c[0])).toEqual([
      { dryRun: true, limit: 500 },
      { dryRun: true, limit: 500 },
      { dryRun: false, limit: 20 },
    ]);
  });

  it("400s on an invalid limit", async () => {
    await post("/review/auto-approve?limit=0").expect(400);
    await post("/review/auto-approve?limit=5001").expect(400);
    expect(autoApprove.backfill).not.toHaveBeenCalled();
  });

  it("409s when the switch is off", async () => {
    autoApprove.backfill.mockRejectedValue(new ConflictException("Auto-approve is disabled"));
    const res = await post("/review/auto-approve?dryRun=false").expect(409);
    expect(res.body.message).toMatch(/disabled/);
  });
});
