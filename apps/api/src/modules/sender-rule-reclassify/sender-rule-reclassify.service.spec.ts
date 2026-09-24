import { INestApplication, Logger, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import request from "supertest";
import { ClientHeaderGuard } from "../../common/client-header";
import {
  SenderRuleReclassifyQuery,
  SenderRuleReclassifyQuerySchema,
} from "@email-ai/shared";
import { DatabaseService } from "../database/database.service";
import { AiProviderService } from "../ai-provider/ai-provider.service";
import {
  BreakerOpenError,
  ProviderRequestRejectedError,
} from "../ai-provider/ai-provider.error";
import { ClassificationService } from "../classification/classification.service";
import { SenderRulesService } from "../sender-rules/sender-rules.service";
import { SenderRuleReclassifyController } from "./sender-rule-reclassify.controller";
import {
  ClassificationSnapshot,
  SenderRuleReclassifyService,
  aiUnavailableReason,
  releaseReviewReason,
} from "./sender-rule-reclassify.service";

// ---------------------------------------------------------------- fixtures

interface Rule {
  id: string;
  pattern: string;
  matchType: "address" | "domain" | "domain_suffix" | "glob" | "regex";
  action: "classify" | "trash";
  category: string;
  enabled: boolean;
  note: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

interface Email {
  id: string;
  fromAddress: string;
  senderDomain: string;
  subject: string;
}

type ClassRow = ClassificationSnapshot & {
  id: string;
  normalizedEmailId: string;
  createdAt: Date;
};

interface Revision {
  id: string;
  batchId: string;
  action: string;
  status: string;
  normalizedEmailId: string;
  classificationId: string | null;
  senderRuleId: string | null;
  previous: unknown;
  next: unknown;
  undoneAt: Date | null;
  createdAt: Date;
}

let ruleSeq = 0;
function rule(id: string, pattern: string, over: Partial<Rule> = {}): Rule {
  return {
    id,
    pattern,
    matchType: "domain",
    action: "classify",
    category: "marketing",
    enabled: true,
    note: null,
    source: "manual",
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, ruleSeq++)),
    updatedAt: new Date(),
    ...over,
  };
}

function email(id: string, fromAddress: string): Email {
  return {
    id,
    fromAddress,
    senderDomain: fromAddress.slice(fromAddress.indexOf("@") + 1),
    subject: `Subject ${id}`,
  };
}

/** A row exactly as classification's rule path writes it. */
function ruleRow(id: string, emailId: string, r: Rule, matchedOn = "domain"): ClassRow {
  const recommendedAction =
    r.category === "delete"
      ? "delete"
      : r.category === "archive"
        ? "archive"
        : r.category === "marketing"
          ? "unsubscribe"
          : "mark_read";
  return {
    id,
    normalizedEmailId: emailId,
    category: r.category,
    importance: "low",
    urgency: "none",
    recommendedAction,
    confidence: "high",
    needsReview: false,
    reason: `Sender rule ${r.id}: ${r.matchType} "${r.pattern}"`,
    providerUsed: "sender-rule",
    senderRuleId: r.id,
    rawResponse: JSON.stringify({
      ruleId: r.id,
      matchType: r.matchType,
      pattern: r.pattern,
      matchedOn,
    }),
    classificationError: null,
    createdAt: new Date(),
  };
}

function aiRow(id: string, emailId: string, over: Partial<ClassRow> = {}): ClassRow {
  return {
    id,
    normalizedEmailId: emailId,
    category: "receipt",
    importance: "medium",
    urgency: "none",
    recommendedAction: "archive",
    confidence: "medium",
    needsReview: false,
    reason: "AI said so",
    providerUsed: "typesafe",
    senderRuleId: null,
    rawResponse: "{}",
    classificationError: null,
    createdAt: new Date(),
    ...over,
  };
}

const AI_OUTPUT = {
  category: "personal",
  importance: "high",
  urgency: "today",
  recommendedAction: "read_now",
  confidence: "high",
  needsReview: false,
  reason: "AI reclassified",
};

// ---------------------------------------------------------------- fake db

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>, reviewed: Set<string>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "reviewDecision") {
      const wantNone = (value as { is: null }).is === null;
      if (wantNone && reviewed.has(row.id as string)) return false;
      continue;
    }
    if (row[key] !== value) return false;
  }
  return true;
}

function makeDb(opts: { rules: Rule[]; emails: Email[]; rows: ClassRow[]; reviewed?: string[] }) {
  const state = {
    rules: opts.rules,
    emails: new Map(opts.emails.map((e) => [e.id, e])),
    rows: new Map(opts.rows.map((r) => [r.id, { ...r }])),
    reviewed: new Set(opts.reviewed ?? []),
    revisions: [] as Revision[],
  };
  let seq = 0;
  const failures: { op: string; left: number; error?: () => Error }[] = [];
  const maybeFail = (op: string) => {
    const f = failures.find((x) => x.op === op && x.left > 0);
    if (f) {
      f.left--;
      throw f.error ? f.error() : new Error(`simulated ${op} failure`);
    }
  };
  /** Runs when a row lock is taken (SELECT ... FOR UPDATE). */
  const onLock: { hook: ((id: string) => void) | null } = { hook: null };
  const byEmail = (emailId: string) =>
    [...state.rows.values()].find((r) => r.normalizedEmailId === emailId) ?? null;
  const withReview = (row: ClassRow | null) =>
    row ? { ...row, reviewDecision: state.reviewed.has(row.id) ? { id: `rd-${row.id}` } : null } : null;

  const db = {
    // Only used for SELECT ... FOR UPDATE row locks.
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      onLock.hook?.(values[0] as string);
      return [];
    }),
    reviewDecision: {
      findUnique: jest.fn(async ({ where }: { where: { classificationId: string } }) =>
        state.reviewed.has(where.classificationId) ? { id: `rd-${where.classificationId}` } : null,
      ),
    },
    senderRule: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        state.rules.find((r) => r.id === where.id) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where?: { enabled?: boolean } } = {}) =>
        state.rules.filter((r) => where?.enabled === undefined || r.enabled === where.enabled),
      ),
    },
    normalizedEmail: {
      // ClassificationService.classifyEmail
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const e = state.emails.get(where.id);
        if (!e) return null;
        return {
          id: e.id,
          senderDomain: e.senderDomain,
          cleanedText: "body",
          ruleCategory: null,
          ruleConfidence: null,
          ruleReasons: [],
          isNewsletter: false,
          isBulk: false,
          parsedEmail: { subject: e.subject, fromAddress: e.fromAddress, fromName: null },
          classification: byEmail(e.id),
        };
      }),
    },
    emailClassification: {
      findMany: jest.fn(
        async (args: {
          where: { senderRuleId?: string };
          take: number;
          cursor?: { id: string };
          skip?: number;
        }) => {
          let rows = [...state.rows.values()]
            .filter((r) => args.where.senderRuleId === undefined || r.senderRuleId === args.where.senderRuleId)
            .sort((a, b) => (a.id < b.id ? -1 : 1));
          if (args.cursor) {
            rows = rows.slice(rows.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0));
          }
          return rows.slice(0, args.take).map((r) => {
            const e = state.emails.get(r.normalizedEmailId)!;
            return {
              ...withReview(r),
              normalizedEmail: {
                senderDomain: e.senderDomain,
                parsedEmail: { fromAddress: e.fromAddress, subject: e.subject },
              },
            };
          });
        },
      ),
      findUnique: jest.fn(async ({ where }: { where: { id?: string; normalizedEmailId?: string } }) =>
        withReview(where.id ? (state.rows.get(where.id) ?? null) : byEmail(where.normalizedEmailId!)),
      ),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<ClassRow> }) => {
        maybeFail("emailClassification.updateMany");
        let count = 0;
        for (const r of state.rows.values()) {
          if (matchesWhere(r, where, state.reviewed)) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      }),
      deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        maybeFail("emailClassification.deleteMany");
        let count = 0;
        for (const r of [...state.rows.values()]) {
          if (matchesWhere(r, where, state.reviewed)) {
            state.rows.delete(r.id);
            count++;
          }
        }
        return { count };
      }),
      create: jest.fn(async ({ data }: { data: Omit<ClassRow, "id" | "createdAt"> & { id?: string } }) => {
        maybeFail("emailClassification.create");
        if (byEmail(data.normalizedEmailId)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        const row = { id: data.id ?? `c-new${++seq}`, createdAt: new Date(), ...data } as ClassRow;
        state.rows.set(row.id, row);
        return row;
      }),
      // ClassificationService.persist
      upsert: jest.fn(
        async ({ where, create, update }: { where: { normalizedEmailId: string }; create: Omit<ClassRow, "id" | "createdAt">; update: Partial<ClassRow> }) => {
          const existing = byEmail(where.normalizedEmailId);
          if (existing) return Object.assign(existing, update);
          const row = { id: `c-new${++seq}`, createdAt: new Date(), ...create } as ClassRow;
          state.rows.set(row.id, row);
          return row;
        },
      ),
    },
    classificationRevision: {
      create: jest.fn(async ({ data }: { data: Partial<Revision> }) => {
        maybeFail("classificationRevision.create");
        const rev: Revision = {
          id: `rev${++seq}`,
          batchId: data.batchId!,
          action: data.action!,
          status: data.status!,
          normalizedEmailId: data.normalizedEmailId!,
          classificationId: data.classificationId ?? null,
          senderRuleId: data.senderRuleId ?? null,
          previous: data.previous,
          next: data.next ?? null,
          undoneAt: null,
          createdAt: new Date(Date.now() + seq),
        };
        state.revisions.push(rev);
        return rev;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Revision> }) => {
        const rev = state.revisions.find((r) => r.id === where.id)!;
        return Object.assign(rev, data);
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; undoneAt: null }; data: Partial<Revision> }) => {
        const rev = state.revisions.find((r) => r.id === where.id && r.undoneAt === null);
        if (!rev) return { count: 0 };
        Object.assign(rev, data);
        return { count: 1 };
      }),
      findMany: jest.fn(async ({ where }: { where: { batchId: string } }) =>
        state.revisions
          .filter((r) => r.batchId === where.batchId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      ),
    },
    // All-or-nothing, like Prisma's interactive transaction.
    $transaction: jest.fn(async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const saved = {
        rows: new Map([...state.rows].map(([k, v]) => [k, { ...v }])),
        revisions: state.revisions.map((r) => ({ ...r })),
      };
      try {
        return await fn(db);
      } catch (error) {
        state.rows = saved.rows;
        state.revisions = saved.revisions;
        throw error;
      }
    }),
  };
  return { db, state, failures, onLock };
}

type Fixture = ReturnType<typeof makeDb>;

async function makeService(
  fx: Fixture,
  ai: { provider?: string | null; judge?: jest.Mock; breakerOpen?: boolean } = {},
) {
  const judgeWith =
    ai.judge ?? jest.fn(async () => ({ output: AI_OUTPUT, rawResponse: '{"ai":true}' }));
  const aiProvider = {
    getActiveProviderType: jest.fn(async () => (ai.provider === undefined ? "typesafe" : ai.provider)),
    judgeWith,
    complete: jest.fn(),
    getBreakerStatus: jest.fn(() => ({ open: ai.breakerOpen ?? false })),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [SenderRuleReclassifyController],
    providers: [
      SenderRuleReclassifyService,
      SenderRulesService,
      ClassificationService,
      { provide: DatabaseService, useValue: fx.db },
      { provide: AiProviderService, useValue: aiProvider },
    ],
  }).compile();
  return {
    moduleRef,
    service: moduleRef.get(SenderRuleReclassifyService),
    senderRules: moduleRef.get(SenderRulesService),
    aiProvider,
    judgeWith,
  };
}

const q = (over: Record<string, string> = {}): SenderRuleReclassifyQuery =>
  SenderRuleReclassifyQuerySchema.parse({ dryRun: "false", ...over });

// ---------------------------------------------------------------- tests

beforeAll(() => {
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});

/**
 * Rule r1 (shop.example) wrote three rows. Since then r1 was edited:
 * recategorized to newsletter, so row c1 needs an update. c2 was written
 * with the new values already (unchanged). c3 is from a sender r1 no
 * longer covers (released).
 */
function editedRuleFixture() {
  const r1 = rule("r1", "shop.example", { category: "newsletter" });
  const oldR1 = { ...r1, category: "marketing" };
  const oldPatternR1 = { ...r1, pattern: "old.example" };
  return makeDb({
    rules: [r1],
    emails: [
      email("n1", "deals@shop.example"),
      email("n2", "news@shop.example"),
      email("n3", "hello@old.example"),
    ],
    rows: [ruleRow("c1", "n1", oldR1), ruleRow("c2", "n2", r1), ruleRow("c3", "n3", oldPatternR1)],
  });
}

describe("SenderRuleReclassifyService.reclassify", () => {
  it("dry run (default) writes nothing and reports counts and a sample", async () => {
    const fx = editedRuleFixture();
    const before = JSON.stringify([...fx.state.rows.values()]);
    const { service, judgeWith } = await makeService(fx);

    const res = await service.reclassify("r1", SenderRuleReclassifyQuerySchema.parse({}));

    expect(res.dryRun).toBe(true);
    expect(res.batchId).toBeNull();
    expect(res.counts).toMatchObject({ update: 1, release: 1, unchanged: 1, claim: 0, skippedReviewed: 0 });
    // c3 has no other rule: it would go to the AI provider.
    expect(res.aiCalls).toBe(1);
    expect(res.aiProvider).toBe("typesafe");
    expect(res.estimatedAiCostUsd).toBeCloseTo(0.000189, 6);
    expect(res.more).toBe(false);
    expect(res.sample).toEqual([
      expect.objectContaining({
        normalizedEmailId: "n1",
        action: "update",
        fromAddress: "deals@shop.example",
        from: { category: "marketing", recommendedAction: "unsubscribe", providerUsed: "sender-rule" },
        to: { category: "newsletter", recommendedAction: "mark_read" },
      }),
      expect.objectContaining({ normalizedEmailId: "n3", action: "release", to: null }),
    ]);
    expect(fx.state.revisions).toHaveLength(0);
    expect(JSON.stringify([...fx.state.rows.values()])).toBe(before);
    expect(judgeWith).not.toHaveBeenCalled();
    expect(fx.db.$transaction).not.toHaveBeenCalled();
  });

  it("linked, live: updates still-matching rows, leaves unchanged ones, releases and reclassifies via AI", async () => {
    const fx = editedRuleFixture();
    const { service, judgeWith } = await makeService(fx);

    const res = await service.reclassify("r1", q());

    expect(res.batchId).toEqual(expect.any(String));
    expect(res.counts).toMatchObject({ update: 1, unchanged: 1, release: 1, reclassified: 1, deferred: 0, errors: 0 });
    expect(res.aiCalls).toBe(1);
    expect(judgeWith).toHaveBeenCalledTimes(1);

    expect(fx.state.rows.get("c1")).toMatchObject({ category: "newsletter", recommendedAction: "mark_read" });
    expect(fx.state.rows.get("c3")).toBeUndefined();
    const n3 = [...fx.state.rows.values()].find((r) => r.normalizedEmailId === "n3");
    expect(n3).toMatchObject({ providerUsed: "typesafe", category: "personal", senderRuleId: null });

    const revs = fx.state.revisions;
    expect(revs.map((r) => [r.action, r.status])).toEqual([
      ["update", "applied"],
      ["release", "reclassified"],
    ]);
    expect(revs.every((r) => r.batchId === res.batchId && r.senderRuleId === "r1")).toBe(true);
    expect(revs[0].previous).toMatchObject({ category: "marketing", providerUsed: "sender-rule", senderRuleId: "r1" });
    expect(revs[1]).toMatchObject({ classificationId: "c3", next: expect.objectContaining({ category: "personal" }) });
    expect(res.sample.find((s) => s.normalizedEmailId === "n3")?.to).toEqual({
      category: "personal",
      recommendedAction: "read_now",
    });
  });

  it("releases a row another, more specific rule now wins and reclassifies it by that rule (no AI)", async () => {
    const r1 = rule("r1", "shop.example");
    const r2 = rule("r2", "vip@shop.example", { matchType: "address", category: "personal" });
    const fx = makeDb({
      rules: [r1, r2],
      emails: [email("n1", "vip@shop.example")],
      rows: [ruleRow("c1", "n1", r1)],
    });
    const { service, judgeWith } = await makeService(fx);

    const dry = await service.reclassify("r1", SenderRuleReclassifyQuerySchema.parse({}));
    expect(dry.counts.release).toBe(1);
    expect(dry.aiCalls).toBe(0);
    expect(dry.estimatedAiCostUsd).toBe(0);
    expect(dry.sample[0].to).toEqual({ category: "personal", recommendedAction: "mark_read" });

    const res = await service.reclassify("r1", q());
    expect(res.counts).toMatchObject({ release: 1, reclassified: 1 });
    expect(res.aiCalls).toBe(0);
    expect(judgeWith).not.toHaveBeenCalled();
    const row = [...fx.state.rows.values()][0];
    expect(row).toMatchObject({ senderRuleId: "r2", category: "personal", providerUsed: "sender-rule" });
  });

  it("disabled rule: every linked row is released; scope=matching claims nothing", async () => {
    const r1 = rule("r1", "shop.example", { enabled: false });
    const fx = makeDb({
      rules: [r1],
      emails: [email("n1", "a@shop.example"), email("n2", "b@shop.example")],
      rows: [ruleRow("c1", "n1", r1), aiRow("c2", "n2")],
    });
    const { service } = await makeService(fx);

    const res = await service.reclassify("r1", SenderRuleReclassifyQuerySchema.parse({ scope: "matching" }));
    expect(res.counts).toMatchObject({ release: 1, claim: 0, update: 0 });
    expect(res.sample.map((s) => s.normalizedEmailId)).toEqual(["n1"]);
  });

  it("scope=matching claims AI rows this rule wins, never rows another rule wins", async () => {
    const r1 = rule("r1", "shop.example");
    const r2 = rule("r2", "vip@shop.example", { matchType: "address", category: "personal" });
    const fx = makeDb({
      rules: [r1, r2],
      emails: [
        email("n1", "deals@shop.example"),
        email("n2", "vip@shop.example"),
        email("n3", "someone@else.example"),
      ],
      rows: [aiRow("c1", "n1"), aiRow("c2", "n2"), aiRow("c3", "n3")],
    });
    const { service } = await makeService(fx);

    const linked = await service.reclassify("r1", q());
    expect(linked.counts).toMatchObject({ claim: 0, update: 0, release: 0 });

    const res = await service.reclassify("r1", q({ scope: "matching" }));
    expect(res.counts).toMatchObject({ claim: 1, update: 0, release: 0, unchanged: 0 });
    expect(fx.state.rows.get("c1")).toMatchObject({
      providerUsed: "sender-rule",
      senderRuleId: "r1",
      needsReview: false,
      category: "marketing",
      recommendedAction: "unsubscribe",
    });
    expect(fx.state.rows.get("c2")).toMatchObject({ providerUsed: "typesafe", senderRuleId: null });
    expect(fx.state.rows.get("c3")).toMatchObject({ providerUsed: "typesafe" });
    expect(fx.state.revisions).toEqual([
      expect.objectContaining({ action: "claim", status: "applied", classificationId: "c1" }),
    ]);
  });

  it("never changes a row with a ReviewDecision", async () => {
    const r1 = rule("r1", "shop.example", { category: "newsletter" });
    const oldR1 = { ...r1, category: "marketing" };
    const fx = makeDb({
      rules: [r1],
      emails: [email("n1", "a@shop.example"), email("n2", "b@shop.example"), email("n3", "c@gone.example")],
      rows: [ruleRow("c1", "n1", oldR1), aiRow("c2", "n2"), ruleRow("c3", "n3", { ...r1, pattern: "gone.example" })],
      reviewed: ["c1", "c2", "c3"],
    });
    const before = JSON.stringify([...fx.state.rows.values()]);
    const { service } = await makeService(fx);

    const res = await service.reclassify("r1", q({ scope: "matching" }));
    expect(res.counts).toMatchObject({ skippedReviewed: 3, update: 0, claim: 0, release: 0 });
    expect(JSON.stringify([...fx.state.rows.values()])).toBe(before);
    expect(fx.state.revisions).toHaveLength(0);
  });

  it("a row reviewed between scan and write is skipped, not changed", async () => {
    const fx = editedRuleFixture();
    const { service } = await makeService(fx);
    // Review lands after the scan read c1.
    const realUpdate = fx.db.emailClassification.updateMany.getMockImplementation()!;
    fx.db.emailClassification.updateMany.mockImplementationOnce(async (args) => {
      fx.state.reviewed.add("c1");
      return realUpdate(args);
    });

    const res = await service.reclassify("r1", q({ release: "mark_review" }));
    expect(res.counts).toMatchObject({ update: 0, skippedReviewed: 1 });
    expect(fx.state.rows.get("c1")?.category).toBe("marketing");
    expect(fx.state.revisions.find((r) => r.classificationId === "c1")).toBeUndefined();
  });

  it("a classification failure after the delete restores the row, flagged for review", async () => {
    const fx = editedRuleFixture();
    // The breaker trips during this run's call.
    const judge = jest.fn(async () => {
      throw new BreakerOpenError("2026-09-24T06:00:00Z", "quota");
    });
    const { service } = await makeService(fx, { judge });

    const res = await service.reclassify("r1", q());
    expect(res.counts).toMatchObject({ release: 1, deferred: 1, reclassified: 0, update: 1 });
    expect(res.aiCalls).toBe(0);
    expect(res.aiUnavailable).toBe(true);
    const c3 = fx.state.rows.get("c3");
    expect(c3).toMatchObject({
      normalizedEmailId: "n3",
      category: "newsletter",
      providerUsed: "sender-rule",
      senderRuleId: "r1",
      needsReview: true,
      reason: aiUnavailableReason("r1", res.batchId!),
    });
    const rev = fx.state.revisions.find((r) => r.action === "release")!;
    expect(rev).toMatchObject({
      status: "marked_review",
      classificationId: "c3",
      next: expect.objectContaining({ needsReview: true }),
    });
    expect(res.sample.find((s) => s.normalizedEmailId === "n3")?.to).toEqual({
      category: "newsletter",
      recommendedAction: "mark_read",
    });
  });

  it("restores the row and counts the AI call when the provider rejects the request", async () => {
    const fx = editedRuleFixture();
    const judge = jest.fn(async () => {
      throw new ProviderRequestRejectedError("typesafe", 422, "bad state");
    });
    const { service } = await makeService(fx, { judge });

    const res = await service.reclassify("r1", q());
    expect(res.counts.deferred).toBe(1);
    expect(res.aiCalls).toBe(1);
    // Any release that could not be AI-reclassified sets the flag.
    expect(res.aiUnavailable).toBe(true);
    expect(fx.state.rows.get("c3")).toMatchObject({ needsReview: true });
  });

  it("breaker open at the start: AI-dependent releases are flagged, never deleted", async () => {
    const fx = editedRuleFixture();
    const { service, judgeWith } = await makeService(fx, { breakerOpen: true });

    const dry = await service.reclassify("r1", SenderRuleReclassifyQuerySchema.parse({}));
    expect(dry.counts).toMatchObject({ release: 1, deferred: 1 });
    expect(dry.aiCalls).toBe(0);
    expect(dry.aiUnavailable).toBe(true);
    expect(fx.state.revisions).toHaveLength(0);

    const res = await service.reclassify("r1", q());
    expect(res.counts).toMatchObject({ release: 1, deferred: 1, reclassified: 0, markedReview: 0, update: 1 });
    expect(res.aiUnavailable).toBe(true);
    expect(judgeWith).not.toHaveBeenCalled();
    expect(fx.db.emailClassification.deleteMany).not.toHaveBeenCalled();
    expect(fx.state.rows.get("c3")).toMatchObject({
      needsReview: true,
      reason: aiUnavailableReason("r1", res.batchId!),
      senderRuleId: "r1",
    });
    expect(fx.state.revisions.find((r) => r.action === "release")).toMatchObject({ status: "marked_review" });
  });

  it("after 3 consecutive provider failures the rest of the run is flagged without AI calls", async () => {
    const oldR1 = rule("r1", "old.example");
    const r1 = { ...oldR1, pattern: "new.example" };
    const emails = Array.from({ length: 5 }, (_, i) => email(`n${i}`, `u${i}@old.example`));
    const fx = makeDb({ rules: [r1], emails, rows: emails.map((e, i) => ruleRow(`c${i}`, e.id, oldR1)) });
    const judge = jest.fn(async () => {
      throw new ProviderRequestRejectedError("typesafe", 422, "bad");
    });
    const { service } = await makeService(fx, { judge });

    const res = await service.reclassify("r1", q());
    expect(judge).toHaveBeenCalledTimes(3);
    expect(fx.db.emailClassification.deleteMany).toHaveBeenCalledTimes(3);
    expect(res.counts).toMatchObject({ release: 5, deferred: 5, reclassified: 0 });
    expect(res.aiCalls).toBe(3);
    expect(res.aiUnavailable).toBe(true);
    // No email was left without a row.
    for (const e of emails) {
      expect([...fx.state.rows.values()].find((r) => r.normalizedEmailId === e.id)).toMatchObject({
        needsReview: true,
      });
    }
    expect(fx.state.revisions.every((r) => r.status === "marked_review")).toBe(true);
  });

  it("a rule-covered release is still reclassified by that rule while the breaker is open", async () => {
    const r1 = rule("r1", "shop.example");
    const r2 = rule("r2", "vip@shop.example", { matchType: "address", category: "personal" });
    const fx = makeDb({
      rules: [r1, r2],
      emails: [email("n1", "vip@shop.example")],
      rows: [ruleRow("c1", "n1", r1)],
    });
    const { service, judgeWith } = await makeService(fx, { breakerOpen: true });

    const res = await service.reclassify("r1", q());
    expect(res.counts).toMatchObject({ release: 1, reclassified: 1, deferred: 0 });
    expect(res.aiUnavailable).toBe(false);
    expect(judgeWith).not.toHaveBeenCalled();
    expect([...fx.state.rows.values()][0]).toMatchObject({ senderRuleId: "r2", category: "personal" });
  });

  it("uses the rules in the database, not the per-process matcher cache", async () => {
    const fx = editedRuleFixture();
    const { service, senderRules } = await makeService(fx);
    // Cache the rules as they are now...
    await senderRules.getMatcher();
    // ...then the other API process recategorizes r1 back to marketing.
    fx.state.rules = [{ ...fx.state.rules[0], category: "marketing" }];

    const res = await service.reclassify("r1", SenderRuleReclassifyQuerySchema.parse({}));
    // c1 (marketing) is now current; c2 (newsletter) needs an update.
    expect(res.counts).toMatchObject({ update: 1, unchanged: 1 });
    expect(res.sample[0]).toMatchObject({ normalizedEmailId: "n2", to: { category: "marketing" } });

    // ...and disables it: every linked row releases.
    fx.state.rules = [{ ...fx.state.rules[0], enabled: false }];
    const disabled = await service.reclassify("r1", SenderRuleReclassifyQuerySchema.parse({}));
    expect(disabled.counts).toMatchObject({ release: 3, update: 0, unchanged: 0 });
  });

  it("classifies released rows with the fresh matcher too", async () => {
    const r1 = rule("r1", "shop.example");
    const fx = makeDb({
      rules: [r1],
      emails: [email("n1", "vip@shop.example")],
      rows: [ruleRow("c1", "n1", r1)],
    });
    const { service, senderRules, judgeWith } = await makeService(fx);
    await senderRules.getMatcher(); // cache without r2
    fx.state.rules = [
      { ...r1, pattern: "other.example" },
      rule("r2", "vip@shop.example", { matchType: "address", category: "personal" }),
    ];

    const res = await service.reclassify("r1", q());
    expect(res.counts).toMatchObject({ release: 1, reclassified: 1 });
    expect(judgeWith).not.toHaveBeenCalled();
    expect([...fx.state.rows.values()][0]).toMatchObject({ senderRuleId: "r2" });
  });

  it("a pattern-only edit counts linked rows as update (reason and rawResponse change)", async () => {
    const oldR1 = rule("r1", "mail.shop.example", { matchType: "domain_suffix" });
    const r1 = { ...oldR1, pattern: "shop.example" };
    const fx = makeDb({
      rules: [r1],
      emails: [email("n1", "a@mail.shop.example")],
      rows: [ruleRow("c1", "n1", oldR1)],
    });
    const { service } = await makeService(fx);

    const res = await service.reclassify("r1", q());
    expect(res.counts).toMatchObject({ update: 1, unchanged: 0 });
    expect(res.sample[0]).toMatchObject({
      from: { category: "marketing" },
      to: { category: "marketing", recommendedAction: "unsubscribe" },
    });
    expect(fx.state.rows.get("c1")?.reason).toBe('Sender rule r1: domain_suffix "shop.example"');
  });

  it("locks the row before checking for a review: a review that wins the lock is respected", async () => {
    const fx = editedRuleFixture();
    const { service } = await makeService(fx);
    fx.onLock.hook = (id) => {
      if (id === "c1" || id === "c3") fx.state.reviewed.add(id);
    };

    const res = await service.reclassify("r1", q());
    expect(res.counts).toMatchObject({ update: 0, release: 0, skippedReviewed: 2 });
    expect(fx.state.revisions).toHaveLength(0);
    expect(fx.state.rows.get("c3")).toBeDefined();
    expect(fx.db.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("release=mark_review keeps the row, flags it for review, and makes no AI call", async () => {
    const fx = editedRuleFixture();
    const { service, judgeWith } = await makeService(fx);

    const dry = await service.reclassify("r1", SenderRuleReclassifyQuerySchema.parse({ release: "mark_review" }));
    expect(dry.aiCalls).toBe(0);
    expect(dry.estimatedAiCostUsd).toBe(0);

    const res = await service.reclassify("r1", q({ release: "mark_review" }));
    expect(res.counts).toMatchObject({ release: 1, markedReview: 1, reclassified: 0, deferred: 0 });
    expect(res.aiCalls).toBe(0);
    expect(judgeWith).not.toHaveBeenCalled();
    expect(fx.state.rows.get("c3")).toMatchObject({
      needsReview: true,
      reason: releaseReviewReason("r1", res.batchId!),
      category: "newsletter",
      senderRuleId: "r1",
    });
    expect(fx.state.revisions.find((r) => r.action === "release")).toMatchObject({ status: "marked_review" });

    // Running it again finds nothing more to mark.
    const again = await service.reclassify("r1", q({ release: "mark_review" }));
    expect(again.counts).toMatchObject({ release: 0, unchanged: 3 });
  });

  it("revision and change are atomic: a failed write leaves neither", async () => {
    const fx = editedRuleFixture();
    fx.failures.push({ op: "emailClassification.updateMany", left: 1 });
    fx.failures.push({ op: "emailClassification.deleteMany", left: 1 });
    const { service, judgeWith } = await makeService(fx);

    const res = await service.reclassify("r1", q());
    expect(res.counts).toMatchObject({ update: 0, release: 0, errors: 2 });
    expect(fx.state.revisions).toHaveLength(0);
    expect(fx.state.rows.get("c1")?.category).toBe("marketing");
    expect(fx.state.rows.get("c3")).toBeDefined();
    expect(judgeWith).not.toHaveBeenCalled();
  });

  it("a failed revision insert leaves the classification unchanged", async () => {
    const fx = editedRuleFixture();
    fx.failures.push({ op: "classificationRevision.create", left: 2 });
    const { service } = await makeService(fx);

    const res = await service.reclassify("r1", q());
    expect(res.counts.errors).toBe(2);
    expect(fx.state.rows.get("c1")?.category).toBe("marketing");
    expect(fx.state.rows.get("c3")).toBeDefined();
  });

  it("respects limit across the run and reports more", async () => {
    const r1 = rule("r1", "shop.example", { category: "newsletter" });
    const oldR1 = { ...r1, category: "marketing" };
    const emails = Array.from({ length: 5 }, (_, i) => email(`n${i}`, `u${i}@shop.example`));
    const fx = makeDb({ rules: [r1], emails, rows: emails.map((e, i) => ruleRow(`c${i}`, e.id, oldR1)) });
    const { service } = await makeService(fx);

    const first = await service.reclassify("r1", q({ limit: "2" }));
    expect(first.counts.update).toBe(2);
    expect(first.more).toBe(true);
    const second = await service.reclassify("r1", q({ limit: "3" }));
    expect(second.counts).toMatchObject({ update: 3, unchanged: 2 });
    expect(second.more).toBe(false);
  });

  it("estimatedAiCostUsd is null for a provider without a price", async () => {
    const fx = editedRuleFixture();
    const { service } = await makeService(fx, { provider: "openai" });
    const res = await service.reclassify("r1", SenderRuleReclassifyQuerySchema.parse({}));
    expect(res.aiCalls).toBe(1);
    expect(res.aiProvider).toBe("openai");
    expect(res.estimatedAiCostUsd).toBeNull();
  });

  it("404s an unknown rule", async () => {
    const fx = editedRuleFixture();
    const { service } = await makeService(fx);
    await expect(service.reclassify("nope", q())).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("SenderRuleReclassifyService.undoBatch", () => {
  it("restores update, claim, reclassified and deferred releases", async () => {
    const r1 = rule("r1", "shop.example", { category: "newsletter" });
    const oldR1 = { ...r1, category: "marketing" };
    const fx = makeDb({
      rules: [r1],
      emails: [
        email("n1", "a@shop.example"),
        email("n2", "b@shop.example"),
        email("n3", "c@old.example"),
        email("n4", "d@old.example"),
      ],
      rows: [
        ruleRow("c1", "n1", oldR1),
        aiRow("c2", "n2"),
        ruleRow("c3", "n3", { ...r1, pattern: "old.example" }),
        ruleRow("c4", "n4", { ...r1, pattern: "old.example" }),
      ],
    });
    const original = new Map([...fx.state.rows].map(([k, v]) => [k, { ...v }]));
    // First release reclassifies, the second hits the breaker.
    const judge = jest
      .fn()
      .mockResolvedValueOnce({ output: AI_OUTPUT, rawResponse: "{}" })
      .mockRejectedValueOnce(new BreakerOpenError());
    const { service } = await makeService(fx, { judge });

    const res = await service.reclassify("r1", q({ scope: "matching" }));
    expect(res.counts).toMatchObject({ update: 1, claim: 1, release: 2, reclassified: 1, deferred: 1 });

    const undo = await service.undoBatch(res.batchId!);
    expect(undo.counts).toEqual({ restored: 4, conflicts: 0, skippedReviewed: 0, alreadyUndone: 0 });
    for (const [id, row] of original) {
      const now = [...fx.state.rows.values()].find((r) => r.normalizedEmailId === row.normalizedEmailId);
      const { createdAt: _a, id: _i, ...want } = row;
      expect(now).toMatchObject(want);
      if (id === "c4") expect(now?.id).toBe("c4"); // deferred: re-created with its old id
    }
    expect(fx.state.revisions.every((r) => r.undoneAt instanceof Date)).toBe(true);

    const again = await service.undoBatch(res.batchId!);
    expect(again.counts).toEqual({ restored: 0, conflicts: 0, skippedReviewed: 0, alreadyUndone: 4 });
  });

  it("refuses rows changed since the batch, and rows reviewed since", async () => {
    const fx = editedRuleFixture();
    fx.state.rows.set("c4", ruleRow("c4", "n4", rule("r1", "shop.example", { category: "marketing" })));
    fx.state.emails.set("n4", email("n4", "z@shop.example"));
    const { service } = await makeService(fx);
    const res = await service.reclassify("r1", q());
    expect(res.counts).toMatchObject({ update: 2, release: 1, reclassified: 1 });

    // c1 edited by hand since; c4 reviewed since; n3's new row changed.
    fx.state.rows.get("c1")!.category = "personal";
    fx.state.reviewed.add("c4");
    const n3 = [...fx.state.rows.values()].find((r) => r.normalizedEmailId === "n3")!;
    n3.needsReview = true;

    const undo = await service.undoBatch(res.batchId!);
    expect(undo.counts).toEqual({ restored: 0, conflicts: 2, skippedReviewed: 1, alreadyUndone: 0 });
    expect(fx.state.rows.get("c1")?.category).toBe("personal");
    expect(fx.state.rows.get("c4")?.category).toBe("newsletter");
    expect(fx.state.revisions.every((r) => r.undoneAt === null)).toBe(true);
  });

  it("a flagged release edited since is a conflict", async () => {
    const fx = editedRuleFixture();
    const { service } = await makeService(fx, {
      judge: jest.fn().mockRejectedValue(new BreakerOpenError()),
    });
    const res = await service.reclassify("r1", q());
    expect(res.counts.deferred).toBe(1);
    fx.state.rows.get("c3")!.category = "personal";

    const undo = await service.undoBatch(res.batchId!);
    expect(undo.counts).toMatchObject({ restored: 1, conflicts: 1 });
    expect(fx.state.rows.get("c3")?.category).toBe("personal");
  });

  it("a foreign-key failure (P2003) counts as a conflict and the batch continues", async () => {
    const fx = editedRuleFixture();
    const { service } = await makeService(fx);
    const res = await service.reclassify("r1", q());
    expect(res.counts).toMatchObject({ update: 1, reclassified: 1 });
    fx.failures.push({
      op: "emailClassification.updateMany",
      left: 1,
      error: () =>
        new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
          code: "P2003",
          clientVersion: "test",
        }),
    });

    const undo = await service.undoBatch(res.batchId!);
    expect(undo.counts).toEqual({ restored: 1, conflicts: 1, skippedReviewed: 0, alreadyUndone: 0 });
    expect(fx.state.revisions.filter((r) => r.undoneAt === null)).toHaveLength(1);
  });

  it("404s an unknown batch", async () => {
    const fx = editedRuleFixture();
    const { service } = await makeService(fx);
    await expect(service.undoBatch("missing")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("SenderRuleReclassifyController (HTTP)", () => {
  let app: INestApplication;
  let fx: Fixture;

  beforeEach(async () => {
    fx = editedRuleFixture();
    const { moduleRef } = await makeService(fx);
    app = moduleRef.createNestApplication();
    app.useGlobalGuards(new ClientHeaderGuard());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (url: string) => request(app.getHttpServer()).post(url).set("X-Email-AI-Client", "test");

  it("403s without the X-Email-AI-Client header", async () => {
    await request(app.getHttpServer()).post("/sender-rules/r1/reclassify").expect(403);
    await request(app.getHttpServer()).post("/sender-rules/reclassify-batches/b/undo").expect(403);
    expect(fx.db.senderRule.findUnique).not.toHaveBeenCalled();
  });

  it("is a dry run unless dryRun is exactly false", async () => {
    const res = await post("/sender-rules/r1/reclassify?dryRun=no").expect(200);
    expect(res.body).toMatchObject({ dryRun: true, scope: "linked", release: "reclassify", limit: 500, batchId: null });
    expect(fx.state.revisions).toHaveLength(0);
  });

  it.each([
    ["limit=0"],
    ["limit=5001"],
    ["limit=abc"],
    ["scope=everything"],
    ["release=delete"],
  ])("400s on %s", async (qs) => {
    await post(`/sender-rules/r1/reclassify?${qs}`).expect(400);
  });

  it("accepts limit=5000", async () => {
    await post("/sender-rules/r1/reclassify?limit=5000").expect(200);
  });

  it("404s an unknown rule and an unknown batch", async () => {
    await post("/sender-rules/nope/reclassify").expect(404);
    await post("/sender-rules/reclassify-batches/nope/undo").expect(404);
  });

  it("applies and undoes over HTTP", async () => {
    const res = await post("/sender-rules/r1/reclassify?dryRun=false").expect(200);
    expect(res.body.batchId).toEqual(expect.any(String));
    const undo = await post(`/sender-rules/reclassify-batches/${res.body.batchId}/undo`).expect(200);
    expect(undo.body).toEqual({
      batchId: res.body.batchId,
      counts: { restored: 2, conflicts: 0, skippedReviewed: 0, alreadyUndone: 0 },
    });
  });
});
