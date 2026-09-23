import { INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import request from "supertest";
import { ClientHeaderGuard } from "../../common/client-header";
import { DatabaseService } from "../database/database.service";
import { SenderRulesController } from "./sender-rules.controller";
import { SenderRulesService } from "./sender-rules.service";

type Row = {
  id: string;
  pattern: string;
  matchType: string;
  action: string;
  category: string;
  enabled: boolean;
  note: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * In-memory stand-in for the Prisma delegates the service uses, including
 * the (matchType, pattern) unique constraint, so the real service and the
 * real ZodValidationPipe run end to end.
 */
function makeDb() {
  const rows = new Map<string, Row>();
  let seq = 0;
  const duplicate = () =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
  const notFound = () =>
    new Prisma.PrismaClientKnownRequestError("Record not found", {
      code: "P2025",
      clientVersion: "test",
    });
  const clash = (data: Partial<Row>, exceptId?: string) =>
    [...rows.values()].some(
      (r) =>
        r.id !== exceptId &&
        r.matchType === data.matchType &&
        r.pattern === data.pattern,
    );

  const senderRule = {
    findMany: jest.fn(async () => [...rows.values()]),
    findUnique: jest.fn(
      async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
    ),
    create: jest.fn(async ({ data }: { data: Omit<Row, "id" | "createdAt" | "updatedAt"> }) => {
      if (clash(data)) throw duplicate();
      const now = new Date();
      const row: Row = { id: `rule${++seq}`, ...data, createdAt: now, updatedAt: now };
      rows.set(row.id, row);
      return row;
    }),
    update: jest.fn(
      async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const existing = rows.get(where.id);
        if (!existing) throw notFound();
        if (clash({ ...existing, ...data }, where.id)) throw duplicate();
        const row = { ...existing, ...data, updatedAt: new Date() };
        rows.set(row.id, row);
        return row;
      },
    ),
    delete: jest.fn(async ({ where }: { where: { id: string } }) => {
      const existing = rows.get(where.id);
      if (!existing) throw notFound();
      rows.delete(where.id);
      return existing;
    }),
  };

  // groupBy returns totals, or the unclassified subset when the query
  // filters on a missing classification.
  const normalizedEmail = {
    groupBy: jest.fn(async (args: { where?: { classification?: null } }) =>
      args.where && "classification" in args.where
        ? [
            { senderDomain: "news.getthefinnewsnow.com", _count: { _all: 7 } },
            { senderDomain: "kickstarter.com", _count: { _all: 1 } },
          ]
        : [
            { senderDomain: "news.getthefinnewsnow.com", _count: { _all: 573 } },
            { senderDomain: "news.financialspiration.com", _count: { _all: 549 } },
            { senderDomain: "news.kickstarter.com", _count: { _all: 2 } },
            { senderDomain: "kickstarter.com", _count: { _all: 93 } },
            { senderDomain: "unknown", _count: { _all: 10 } },
          ],
    ),
  };
  const parsedEmail = {
    groupBy: jest.fn(async (args: { where?: { OR?: unknown } }) =>
      args.where?.OR
        ? [{ fromAddress: "Team@KickstarGo.com", _count: { _all: 2 } }]
        : [
            { fromAddress: "team@kickstargo.com", _count: { _all: 227 } },
            { fromAddress: "Team@KickstarGo.com", _count: { _all: 3 } },
            { fromAddress: "info@kickstargo.com", _count: { _all: 5 } },
          ],
    ),
  };

  // Per-domain classification counts for GET /sender-rules/suggestions.
  const $queryRaw = jest.fn(async () => [
    { domain: "news.getthefinnewsnow.com", total: 573, marketing: 570, newsletter: 0 },
    { domain: "News.Financialspiration.com", total: 549, marketing: 549, newsletter: 0 },
    { domain: "kickstarter.com", total: 93, marketing: 10, newsletter: 5 },
    { domain: "kickstargo.com", total: 230, marketing: 230, newsletter: 0 },
    { domain: "tiny.example.com", total: 3, marketing: 3, newsletter: 0 },
  ]);

  return { rows, senderRule, normalizedEmail, parsedEmail, $queryRaw };
}

describe("SenderRulesController (HTTP)", () => {
  let app: INestApplication;
  let db: ReturnType<typeof makeDb>;
  let service: SenderRulesService;

  beforeEach(async () => {
    db = makeDb();
    const moduleRef = await Test.createTestingModule({
      controllers: [SenderRulesController],
      providers: [SenderRulesService, { provide: DatabaseService, useValue: db }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalGuards(new ClientHeaderGuard());
    await app.init();
    service = moduleRef.get(SenderRulesService);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (body: object) =>
    request(app.getHttpServer()).post("/sender-rules").set("X-Email-AI-Client", "test").send(body);

  describe("POST /sender-rules", () => {
    it("creates a rule: 201 with the rule and no warnings, pattern lowercased", async () => {
      const res = await post({
        pattern: "News.*.Example.com",
        matchType: "glob",
        category: "marketing",
      }).expect(201);

      expect(res.body.warnings).toEqual([]);
      expect(res.body.rule).toMatchObject({
        pattern: "news.*.example.com",
        matchType: "glob",
        action: "classify",
        category: "marketing",
        enabled: true,
        source: "manual",
      });
    });

    it("lowercases a regex but keeps escape sequences as written", async () => {
      const res = await post({
        pattern: "^Backer\\S+\\.COM$",
        matchType: "regex",
        category: "marketing",
      }).expect(201);
      expect(res.body.rule.pattern).toBe("^backer\\S+\\.com$");
    });

    it("returns 409 for the same regex in a different case", async () => {
      await post({
        pattern: "^backer[a-z]+\\.com$",
        matchType: "regex",
        category: "marketing",
      }).expect(201);
      await post({
        pattern: "^BACKER[a-z]+\\.com$",
        matchType: "regex",
        category: "marketing",
      }).expect(409);
    });

    it("lowercases outside character classes only", async () => {
      const res = await post({
        pattern: "^Kick[A-z]+\\.COM$",
        matchType: "regex",
        category: "marketing",
      }).expect(201);
      expect(res.body.rule.pattern).toBe("^kick[A-z]+\\.com$");
    });

    it("rejects more than 3 unbounded quantifiers with 400", async () => {
      const res = await post({
        pattern: "^[a-z.-]*[a-z.-]*[a-z.-]*[a-z.-]*x$",
        matchType: "regex",
        category: "marketing",
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain("unbounded quantifiers");
    });

    it("suggests splitting or glob rules when a regex has optional repetition", async () => {
      const res = await post({
        pattern: "^(k+)?x$",
        matchType: "regex",
        category: "marketing",
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain("kickstar*.com plus *.kickstar*.com");
    });

    it.each(["^(a+)+$", "(a|a)*", "(x+x+)+y"])(
      "rejects the unsafe regex %p with 400",
      async (pattern) => {
        const res = await post({
          pattern,
          matchType: "regex",
          category: "marketing",
        }).expect(400);
        expect(JSON.stringify(res.body)).toContain("regex is unsafe");
      },
    );

    it.each<[string, string]>([
      ["regex", ".*"],
      ["regex", "."],
      ["regex", "com"],
      ["glob", "*.com"],
      ["glob", "*@*.com"],
      ["glob", "*.net"],
      ["glob", "*.co.uk"],
      ["regex", "^noreply@"],
      ["regex", "^no-?reply@"],
      ["regex", "^info@"],
      ["glob", "noreply@*mail*.com"],
      ["domain_suffix", "co.uk"],
      ["domain_suffix", "com.au"],
    ])("rejects the too-broad %s %p with 400", async (matchType, pattern) => {
      const res = await post({ pattern, matchType, category: "marketing" }).expect(
        400,
      );
      expect(JSON.stringify(res.body)).toMatch(/too broad|public suffix/);
      expect(db.senderRule.create).not.toHaveBeenCalled();
    });

    it.each<[string, string]>([
      ["regex", "^backer[a-z]+\\.com$"],
      ["regex", "^info@backer"],
      ["regex", "^noreply@kickstargo\\.com$"],
      ["glob", "news.*.com"],
      ["glob", "*@kickstargo.com"],
      ["domain_suffix", "github.com"],
      ["domain_suffix", "mail.example.co.uk"],
    ])("accepts the narrow %s %p", async (matchType, pattern) => {
      await post({ pattern, matchType, category: "marketing" }).expect(201);
    });

    it("rejects a regex that does not compile with 400 (not 500)", async () => {
      const res = await post({
        pattern: "(abc",
        matchType: "regex",
        category: "marketing",
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain("regex does not compile");
      expect(db.senderRule.create).not.toHaveBeenCalled();
    });

    it("rejects a regex longer than 200 characters", async () => {
      await post({
        pattern: "a".repeat(201),
        matchType: "regex",
        category: "marketing",
      }).expect(400);
    });

    it.each(["*", "*.*", "*@*", "*.co", "a*"])(
      "rejects the too-broad glob %p with 400",
      async (pattern) => {
        await post({ pattern, matchType: "glob", category: "marketing" }).expect(
          400,
        );
      },
    );

    it.each<[string, string]>([
      ["glob", "news.[a-z].com"],
      ["domain", "*.example.com"],
      ["domain_suffix", "com"],
      ["address", "not-an-address"],
    ])("rejects an invalid %s pattern %p with 400", async (matchType, pattern) => {
      await post({ pattern, matchType, category: "marketing" }).expect(400);
    });

    it("rejects a classify rule without a category with 400", async () => {
      const res = await post({
        pattern: "promo.example.com",
        matchType: "domain",
      }).expect(400);
      expect(res.body.fieldErrors.category).toEqual([
        "category is required for classify rules",
      ]);
    });

    it("defaults a trash rule's category to delete", async () => {
      const res = await post({
        pattern: "kstgadgets.com",
        matchType: "domain",
        action: "trash",
      }).expect(201);
      expect(res.body.rule).toMatchObject({ action: "trash", category: "delete" });
    });

    it("returns 409 for a duplicate (matchType, pattern)", async () => {
      await post({
        pattern: "kstgadgets.com",
        matchType: "domain",
        category: "marketing",
      }).expect(201);
      // Case-insensitive duplicate: patterns are stored lowercased.
      await post({
        pattern: "KSTGadgets.com",
        matchType: "domain",
        category: "delete",
      }).expect(409);
    });

    it("warns, but still creates, when the pattern hits a protected sender", async () => {
      const res = await post({
        pattern: "kickstar*.com",
        matchType: "glob",
        category: "marketing",
      }).expect(201);
      expect(res.body.rule.pattern).toBe("kickstar*.com");
      expect(res.body.warnings).toHaveLength(1);
      expect(res.body.warnings[0]).toContain("kickstarter.com");
    });
  });

  describe("GET /sender-rules", () => {
    it("lists rules and 404s an unknown id", async () => {
      const created = await post({
        pattern: "kstgadgets.com",
        matchType: "domain",
        category: "marketing",
      });
      const list = await request(app.getHttpServer())
        .get("/sender-rules")
        .expect(200);
      expect(list.body).toHaveLength(1);

      await request(app.getHttpServer())
        .get(`/sender-rules/${created.body.rule.id}`)
        .expect(200);
      await request(app.getHttpServer()).get("/sender-rules/nope").expect(404);
    });
  });

  describe("X-Email-AI-Client (global guard)", () => {
    it.each([
      ["POST", "/sender-rules", { pattern: "kstgadgets.com", matchType: "domain", category: "marketing" }],
      ["POST", "/sender-rules/preview", { pattern: "news.*.com", matchType: "glob" }],
      ["PATCH", "/sender-rules/any", { note: "x" }],
      ["DELETE", "/sender-rules/any", undefined],
    ] as const)("%s %s without the header is 403 and changes nothing", async (method, path, body) => {
      const agent = request(app.getHttpServer());
      const req =
        method === "POST" ? agent.post(path) : method === "PATCH" ? agent.patch(path) : agent.delete(path);
      const res = await (body ? req.send(body) : req).expect(403);
      expect(res.body.message).toMatch(/X-Email-AI-Client/);
      expect(db.rows.size).toBe(0);
      expect(db.senderRule.create).not.toHaveBeenCalled();
    });

    it("a blank header is rejected too", async () => {
      await request(app.getHttpServer())
        .post("/sender-rules")
        .set("X-Email-AI-Client", "  ")
        .send({ pattern: "kstgadgets.com", matchType: "domain", category: "marketing" })
        .expect(403);
    });

    it("GET needs no header", async () => {
      await request(app.getHttpServer()).get("/sender-rules").expect(200);
    });
  });

  describe("PATCH /sender-rules/:id", () => {
    it("re-validates the stored pattern when matchType changes", async () => {
      const created = await post({
        pattern: "news.*.example.com",
        matchType: "glob",
        category: "marketing",
      }).expect(201);
      const id = created.body.rule.id;

      // A glob pattern is not a valid domain.
      const res = await request(app.getHttpServer())
        .patch(`/sender-rules/${id}`).set("X-Email-AI-Client", "test")
        .send({ matchType: "domain" })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain("hostname");
      expect(db.senderRule.update).not.toHaveBeenCalled();

      // Changing both together is fine.
      const ok = await request(app.getHttpServer())
        .patch(`/sender-rules/${id}`).set("X-Email-AI-Client", "test")
        .send({ matchType: "domain", pattern: "News.Example.com" })
        .expect(200);
      expect(ok.body.rule).toMatchObject({
        matchType: "domain",
        pattern: "news.example.com",
        category: "marketing",
      });
      expect(ok.body.warnings).toEqual([]);
    });

    it("returns warnings for a protected hit and 404 for an unknown id", async () => {
      const created = await post({
        pattern: "promo.example.com",
        matchType: "domain",
        category: "marketing",
      });
      const res = await request(app.getHttpServer())
        .patch(`/sender-rules/${created.body.rule.id}`).set("X-Email-AI-Client", "test")
        .send({ pattern: "songkick.com", matchType: "domain_suffix" })
        .expect(200);
      expect(res.body.warnings[0]).toContain("songkick.com");

      await request(app.getHttpServer())
        .patch("/sender-rules/nope").set("X-Email-AI-Client", "test")
        .send({ enabled: false })
        .expect(404);
    });

    it("returns 409 when the update collides with another rule", async () => {
      await post({ pattern: "a-promo.com", matchType: "domain", category: "marketing" });
      const b = await post({
        pattern: "b-promo.com",
        matchType: "domain",
        category: "marketing",
      });
      await request(app.getHttpServer())
        .patch(`/sender-rules/${b.body.rule.id}`).set("X-Email-AI-Client", "test")
        .send({ pattern: "a-promo.com" })
        .expect(409);
    });
  });

  describe("DELETE /sender-rules/:id", () => {
    it("returns 204, then 404", async () => {
      const created = await post({
        pattern: "kstgadgets.com",
        matchType: "domain",
        category: "marketing",
      });
      const id = created.body.rule.id;
      await request(app.getHttpServer()).delete(`/sender-rules/${id}`).set("X-Email-AI-Client", "test").expect(204);
      await request(app.getHttpServer()).delete(`/sender-rules/${id}`).set("X-Email-AI-Client", "test").expect(404);
    });
  });

  describe("POST /sender-rules/preview", () => {
    it("counts matching stored mail by domain, top first, with protected hits", async () => {
      const res = await request(app.getHttpServer())
        .post("/sender-rules/preview").set("X-Email-AI-Client", "test")
        .send({ pattern: "news.*.com", matchType: "glob" })
        .expect(200);

      expect(res.body).toEqual({
        matchedEmails: 573 + 549 + 2,
        unclassifiedMatches: 7,
        domains: [
          { domain: "news.getthefinnewsnow.com", count: 573 },
          { domain: "news.financialspiration.com", count: 549 },
          { domain: "news.kickstarter.com", count: 2 },
        ],
        protectedHits: [
          "backerkit.com",
          "kickstarter.com",
          "news.kickstarter.com",
          "pledgebox.com",
          "songkick.com",
        ],
      });
      expect(db.parsedEmail.groupBy).not.toHaveBeenCalled();
    });

    it("uses from addresses for address-targeted patterns, case-insensitively", async () => {
      const res = await request(app.getHttpServer())
        .post("/sender-rules/preview").set("X-Email-AI-Client", "test")
        .send({ pattern: "Team@KickstarGo.com", matchType: "address" })
        .expect(200);
      expect(res.body).toEqual({
        matchedEmails: 230,
        unclassifiedMatches: 2,
        domains: [{ domain: "kickstargo.com", count: 230 }],
        protectedHits: [],
      });
      expect(db.normalizedEmail.groupBy).not.toHaveBeenCalled();
    });

    it("rejects an invalid or too-broad pattern with 400", async () => {
      for (const body of [
        { pattern: "(abc", matchType: "regex" },
        { pattern: "*.com", matchType: "glob" },
      ]) {
        await request(app.getHttpServer())
          .post("/sender-rules/preview").set("X-Email-AI-Client", "test")
          .send(body)
          .expect(400);
      }
    });
  });

  describe("GET /sender-rules/suggestions", () => {
    const get = (qs = "") =>
      request(app.getHttpServer()).get(`/sender-rules/suggestions${qs}`);

    /** Bound values of the Prisma.sql template passed to $queryRaw. */
    const sqlValues = () =>
      (db.$queryRaw.mock.calls.at(-1) as unknown as [{ values: unknown[] }])[0]
        .values;

    it("is routed before :id and defaults to typesafe, 20 emails, 90%", async () => {
      const res = await get().expect(200);

      expect(sqlValues()).toEqual(["typesafe"]);
      expect(res.body.families.map((f: { key: string }) => f.key)).toEqual([
        "news.*.com",
        "kickstargo.com",
      ]);
      // Two news.<x>.com members are too few for a news.*.com glob, so each
      // member gets a domain rule.
      expect(res.body.families[0]).toEqual({
        key: "news.*.com",
        kind: "news-subdomain",
        totalEmails: 573 + 549,
        domains: [
          { domain: "news.getthefinnewsnow.com", total: 573, share: 0.9948 },
          { domain: "news.financialspiration.com", total: 549, share: 1 },
        ],
        proposedRules: [
          {
            pattern: "news.getthefinnewsnow.com",
            matchType: "domain",
            action: "classify",
            category: "marketing",
          },
          {
            pattern: "news.financialspiration.com",
            matchType: "domain",
            action: "classify",
            category: "marketing",
          },
        ],
        excludedLegit: [],
      });
      expect(db.senderRule.findUnique).not.toHaveBeenCalled();
    });

    it("passes provider, minEmails and minShare through", async () => {
      const res = await get("?provider=openai&minEmails=500&minShare=0.99").expect(200);
      expect(sqlValues()).toEqual(["openai"]);
      // 570/573 = 0.9948 >= 0.99 and 549/549; kickstargo is under 500.
      expect(res.body.families.map((f: { key: string }) => f.key)).toEqual([
        "news.*.com",
      ]);
      const low = await get("?minEmails=1&minShare=0.5").expect(200);
      // Singles are keyed by registrable domain; the hostname is a member.
      const single = low.body.families.find(
        (f: { key: string }) => f.key === "example.com",
      );
      expect(single.domains).toEqual([
        { domain: "tiny.example.com", total: 3, share: 1 },
      ]);
    });

    it("rejects invalid params with 400", async () => {
      for (const qs of [
        "?minEmails=0",
        "?minEmails=abc",
        "?minShare=0",
        "?minShare=1.5",
        "?provider=type%20safe;drop",
      ]) {
        await get(qs).expect(400);
      }
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it("never writes: no rule is created, updated or deleted", async () => {
      await get("?minEmails=1").expect(200);
      expect(db.senderRule.create).not.toHaveBeenCalled();
      expect(db.senderRule.update).not.toHaveBeenCalled();
      expect(db.senderRule.delete).not.toHaveBeenCalled();
      expect(db.rows.size).toBe(0);
    });

    it("skips domains an enabled rule already covers", async () => {
      await post({
        pattern: "kickstargo.com",
        matchType: "domain",
        category: "marketing",
      }).expect(201);
      const res = await get().expect(200);
      expect(res.body.families.map((f: { key: string }) => f.key)).not.toContain(
        "kickstargo.com",
      );
    });
  });

  describe("getMatcher cache", () => {
    it("reuses the compiled matcher until a write invalidates it", async () => {
      const first = await service.getMatcher();
      expect(await service.getMatcher()).toBe(first);
      expect(db.senderRule.findMany).toHaveBeenCalledTimes(1);

      await post({ pattern: "kstgadgets.com", matchType: "domain", category: "delete" });
      const second = await service.getMatcher();
      expect(second).not.toBe(first);
      expect(second.size).toBe(1);
      expect(db.senderRule.findMany).toHaveBeenLastCalledWith({
        where: { enabled: true },
      });
    });
  });
});

describe("SenderRulesService.getMatcher — skipped rules", () => {
  it("logs one warning per compile naming stored regexes it skipped", async () => {
    const now = new Date();
    const stored = [
      { id: "bad1", pattern: "^(a+)+$", matchType: "regex", enabled: true },
      { id: "bad2", pattern: "(abc", matchType: "regex", enabled: true },
      { id: "ok", pattern: "kstgadgets.com", matchType: "domain", enabled: true },
    ].map((r) => ({
      ...r,
      action: "classify",
      category: "marketing",
      note: null,
      source: "manual",
      createdAt: now,
      updatedAt: now,
    }));
    const db = { senderRule: { findMany: jest.fn().mockResolvedValue(stored) } };
    const service = new SenderRulesService(db as unknown as DatabaseService);
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    const matcher = await service.getMatcher();
    await service.getMatcher(); // cached: no second compile, no second log

    expect(matcher.size).toBe(1);
    expect(matcher.skipped).toEqual(["bad1", "bad2"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("bad1, bad2");
    warn.mockRestore();
  });
});
