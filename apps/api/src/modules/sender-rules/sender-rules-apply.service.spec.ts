import {
  BadRequestException,
  ForbiddenException,
  INestApplication,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ClientHeaderGuard } from "../../common/client-header";
import { SenderRuleApplyQuerySchema } from "@email-ai/shared";
import { AppConfigService } from "../config/config.service";
import { DatabaseService } from "../database/database.service";
import { EmailAccountsService } from "../email-accounts/email-accounts.service";
import { MailboxWriterService } from "../mailbox-actions/mailbox-writer.service";
import { SenderRulesApplyController } from "./sender-rules-apply.controller";
import { SenderRulesApplyService } from "./sender-rules-apply.service";

interface Raw {
  id: string;
  accountId: string;
  mailbox: string;
  uid: number;
  uidValidity: string | null;
  fromAddress: string;
  senderDomain: string;
  subject: string;
  messageId: string | null;
  review?: { decision: "approved" | "rejected"; correctedCategory: string | null } | null;
}

interface Action {
  rawEmailId: string | null;
  accountId: string;
  action: string;
  status: string;
  messageId: string | null;
}

const rule = (id: string, pattern: string, over: Record<string, unknown> = {}) => ({
  id,
  pattern,
  matchType: "domain",
  action: "trash",
  category: "delete",
  enabled: true,
  note: null,
  source: "manual",
  createdAt: new Date(`2026-09-0${id.length}T00:00:00Z`),
  updatedAt: new Date(),
  ...over,
});

function source(r: Raw): Buffer {
  return Buffer.from(
    `From: ${r.fromAddress}\r\n` +
      (r.messageId ? `Message-ID: <${r.messageId}>\r\n` : "") +
      `Subject: ${r.subject}\r\n\r\nbody`,
  );
}

function makeFixture(opts: {
  rules?: ReturnType<typeof rule>[];
  raws?: Raw[];
  actions?: Action[];
  accounts?: { id: string; label: string; isActive?: boolean }[];
  writesEnabled?: boolean;
} = {}) {
  const rules = opts.rules ?? [rule("r1", "spam.example")];
  const raws = opts.raws ?? [];
  const actions = opts.actions ?? [];
  const accounts = opts.accounts ?? [{ id: "acc1", label: "Personal" }];

  const db = {
    senderRule: {
      findMany: jest.fn(async ({ where }: { where: { enabled: boolean; action?: string } }) =>
        rules.filter((r) => r.enabled === where.enabled && (!where.action || r.action === where.action)),
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        rules.find((r) => r.id === where.id) ?? null,
      ),
    },
    emailAccount: {
      findMany: jest.fn(async ({ where }: { where: { id?: string } }) =>
        accounts
          .filter((a) => a.isActive !== false && (!where.id || a.id === where.id))
          .map(({ id, label }) => ({ id, label })),
      ),
    },
    mailboxAction: {
      findMany: jest.fn(async ({ where }: { where: { status: { in: string[] }; accountId: { in: string[] } } }) =>
        actions.filter(
          (a) =>
            where.status.in.includes(a.status) &&
            a.action === "move_to_trash" &&
            where.accountId.in.includes(a.accountId),
        ),
      ),
    },
    rawEmail: {
      findMany: jest.fn(async (args: {
        where: {
          id?: { in: string[] };
          accountId?: string;
          mailbox?: string;
          mailboxActions?: { none: { action: string; status: { in: string[] } } };
        };
        select: Record<string, unknown>;
        take?: number;
        skip?: number;
        cursor?: { id: string };
      }) => {
        const { where } = args;
        if (where.id) {
          return raws
            .filter((r) => where.id!.in.includes(r.id))
            .map((r) => ({ id: r.id, rawSource: source(r) }));
        }
        const none = where.mailboxActions!.none;
        let rows = raws
          .filter((r) => r.accountId === where.accountId && r.mailbox === where.mailbox)
          .filter(
            (r) =>
              !actions.some(
                (a) =>
                  a.rawEmailId === r.id &&
                  a.action === none.action &&
                  none.status.in.includes(a.status),
              ),
          )
          .sort((a, b) => a.id.localeCompare(b.id));
        if (args.cursor) {
          rows = rows.slice(rows.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0));
        }
        return rows.slice(0, args.take).map((r) => ({
          id: r.id,
          uid: r.uid,
          uidValidity: r.uidValidity,
          parsed: {
            fromAddress: r.fromAddress,
            subject: r.subject,
            normalized: {
              senderDomain: r.senderDomain,
              classification: r.review === undefined ? null : { reviewDecision: r.review },
            },
          },
        }));
      }),
    },
  };

  const config = { mailboxWritesEnabled: opts.writesEnabled ?? false };
  const factory = jest.fn(() => {
    throw new Error("IMAP client must not be built in this test");
  });
  const credentials = { getImapCredentials: jest.fn() };
  // A real writer with dead IMAP deps: dry runs must never reach them.
  const writer = new MailboxWriterService(
    db as unknown as DatabaseService,
    config as unknown as AppConfigService,
    credentials as unknown as EmailAccountsService,
    factory as unknown as ConstructorParameters<typeof MailboxWriterService>[3],
  );
  const service = new SenderRulesApplyService(
    db as unknown as DatabaseService,
    config as unknown as AppConfigService,
    writer,
  );
  return { service, db, writer, factory, credentials, config };
}

let seq = 0;
const raw = (over: Partial<Raw> = {}): Raw => {
  const n = ++seq;
  return {
    id: `raw${String(n).padStart(4, "0")}`,
    accountId: "acc1",
    mailbox: "INBOX",
    uid: n,
    uidValidity: "100",
    fromAddress: `deals@spam.example`,
    senderDomain: "spam.example",
    subject: `Deal ${n}`,
    messageId: `m${n}@spam.example`,
    ...over,
  };
};

const q = (over: Record<string, string> = {}) => SenderRuleApplyQuerySchema.parse(over);

describe("SenderRuleApplyQuerySchema", () => {
  it.each([[undefined], ["true"], ["FALSE"], ["0"], ["no"], [""]])(
    "dryRun=%p is a dry run",
    (dryRun) => {
      expect(q(dryRun === undefined ? {} : { dryRun }).dryRun).toBe(true);
    },
  );
  it('only "false" turns dry run off', () => {
    expect(q({ dryRun: "false" }).dryRun).toBe(false);
  });
  it("defaults limit to 200 and bounds it", () => {
    expect(q().limit).toBe(200);
    expect(() => q({ limit: "0" })).toThrow();
    expect(() => q({ limit: "5000" })).toThrow();
  });
});

describe("SenderRulesApplyService", () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(["log", "error", "warn"]));
  beforeEach(() => {
    seq = 0;
  });

  it("dry run: reports matches, builds no IMAP client, writes nothing", async () => {
    const raws = [raw(), raw(), raw({ fromAddress: "friend@ok.example", senderDomain: "ok.example" })];
    const f = makeFixture({ raws });
    const moveSpy = jest.spyOn(f.writer, "moveToTrash");

    const out = await f.service.apply(q());

    expect(out).toEqual({
      dryRun: true,
      writesEnabled: false,
      limit: 200,
      totals: { matched: 2, selected: 2, moved: 0, skipped: 0, failed: 0, unknown: 0 },
      byRule: [
        {
          ruleId: "r1",
          pattern: "spam.example",
          matchType: "domain",
          byAccount: [
            {
              accountId: "acc1",
              accountLabel: "Personal",
              matched: 2,
              selected: 2,
              moved: 0,
              skipped: 0,
              failed: 0,
              unknown: 0,
              error: null,
              sample: [
                { rawEmailId: "raw0001", fromAddress: "deals@spam.example", subject: "Deal 1", outcome: "would_move", error: null },
                { rawEmailId: "raw0002", fromAddress: "deals@spam.example", subject: "Deal 2", outcome: "would_move", error: null },
              ],
            },
          ],
        },
      ],
    });
    expect(moveSpy).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.credentials.getImapCredentials).not.toHaveBeenCalled();
    // The fake db has no write methods at all: any write would throw.
    expect(Object.keys(f.db.mailboxAction)).toEqual(["findMany"]);
  });

  it("dry run with writes enabled still builds no IMAP client", async () => {
    const f = makeFixture({ raws: [raw()], writesEnabled: true });
    const out = await f.service.apply(q({ dryRun: "true" }));
    expect(out).toMatchObject({ dryRun: true, writesEnabled: true, totals: { selected: 1, moved: 0 } });
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("dryRun=false with writes disabled is 403 before any read", async () => {
    const f = makeFixture({ raws: [raw()] });
    await expect(f.service.apply(q({ dryRun: "false" }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.db.rawEmail.findMany).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("only uses enabled trash rules", async () => {
    const f = makeFixture({
      rules: [
        rule("r1", "spam.example", { action: "classify" }),
        rule("r22", "spam.example", { enabled: false }),
      ],
      raws: [raw()],
    });
    const out = await f.service.apply(q());
    expect(out.byRule).toEqual([]);
    expect(out.totals.matched).toBe(0);
    expect(f.db.rawEmail.findMany).not.toHaveBeenCalled();
  });

  it("ruleId must name an enabled trash rule", async () => {
    const f = makeFixture({ rules: [rule("r1", "x.example", { action: "classify" })] });
    await expect(f.service.apply(q({ ruleId: "nope" }))).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.apply(q({ ruleId: "r1" }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it("unknown accountId is 404", async () => {
    const f = makeFixture();
    await expect(f.service.apply(q({ accountId: "zzz" }))).rejects.toBeInstanceOf(NotFoundException);
  });

  it("excludes mail with a pending, succeeded, or skipped move", async () => {
    const raws = [raw(), raw(), raw(), raw(), raw()];
    const f = makeFixture({
      raws,
      actions: [
        { rawEmailId: raws[0].id, accountId: "acc1", action: "move_to_trash", status: "pending", messageId: null },
        { rawEmailId: raws[1].id, accountId: "acc1", action: "move_to_trash", status: "succeeded", messageId: null },
        { rawEmailId: raws[2].id, accountId: "acc1", action: "move_to_trash", status: "skipped", messageId: null },
        { rawEmailId: raws[3].id, accountId: "acc1", action: "move_to_trash", status: "failed", messageId: null },
      ],
    });
    const out = await f.service.apply(q());
    // failed is retried; the untouched one is new.
    expect(out.totals.matched).toBe(2);
    const where = f.db.rawEmail.findMany.mock.calls[0][0].where;
    expect(where.mailboxActions).toEqual({
      none: { action: "move_to_trash", status: { in: ["pending", "succeeded", "skipped", "unknown"] } },
    });
    expect(where.mailbox).toBe("INBOX");
  });

  it("excludes messages the user restored with undo, by rawEmailId and by Message-ID", async () => {
    const raws = [
      raw({ messageId: "restored@spam.example" }), // re-ingested copy of an undone message
      raw(), // its own undone action
      raw(), // eligible
    ];
    const f = makeFixture({
      raws,
      actions: [
        { rawEmailId: "rawGONE", accountId: "acc1", action: "move_to_trash", status: "undone", messageId: "restored@spam.example" },
        { rawEmailId: raws[1].id, accountId: "acc1", action: "move_to_trash", status: "undone", messageId: null },
      ],
    });
    const out = await f.service.apply(q());
    expect(out.totals).toMatchObject({ matched: 1, selected: 1 });
    expect(out.byRule[0].byAccount[0].sample.map((s) => s.rawEmailId)).toEqual([raws[2].id]);
  });

  it("an undone Message-ID on another account does not exclude", async () => {
    const raws = [raw({ messageId: "same@x" })];
    const f = makeFixture({
      raws,
      accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B" }],
      actions: [{ rawEmailId: null, accountId: "acc2", action: "move_to_trash", status: "undone", messageId: "same@x" }],
    });
    const out = await f.service.apply(q());
    expect(out.totals.selected).toBe(1);
  });

  it("respects limit across the whole run and caps samples at 10", async () => {
    const raws = [
      ...Array.from({ length: 15 }, () => raw()),
      ...Array.from({ length: 5 }, () => raw({ accountId: "acc2" })),
    ];
    const f = makeFixture({ raws, accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B" }] });
    const out = await f.service.apply(q({ limit: "12" }));
    expect(out.totals).toMatchObject({ matched: 20, selected: 12 });
    const [a1] = out.byRule[0].byAccount;
    expect(a1).toMatchObject({ accountId: "acc1", matched: 15, selected: 12 });
    expect(a1.sample).toHaveLength(10);
    expect(out.byRule[0].byAccount[1]).toMatchObject({ accountId: "acc2", matched: 5, selected: 0, sample: [] });
  });

  it("pages through large INBOXes", async () => {
    const raws = Array.from({ length: 1203 }, () => raw());
    const f = makeFixture({ raws });
    const out = await f.service.apply(q({ limit: "1000" }));
    expect(out.totals).toMatchObject({ matched: 1203, selected: 1000 });
  });

  it("H1: an address classify rule inside a domain trash rule protects that sender", async () => {
    const f = makeFixture({
      rules: [
        rule("r1", "spam.example"),
        rule("r22", "friend@spam.example", { matchType: "address", action: "classify", category: "personal" }),
      ],
      raws: [raw({ fromAddress: "friend@spam.example" }), raw()],
    });
    const out = await f.service.apply(q());
    expect(out.totals).toMatchObject({ matched: 1, selected: 1 });
    expect(out.byRule.map((r) => r.ruleId)).toEqual(["r1"]);
    expect(out.byRule[0].byAccount[0].sample.map((x) => x.fromAddress)).toEqual(["deals@spam.example"]);
  });

  it("H1: ruleId acts only where that rule is the winning rule", async () => {
    const f = makeFixture({
      rules: [rule("r1", "spam.example"), rule("r22", "deals@spam.example", { matchType: "address" })],
      raws: [raw(), raw({ fromAddress: "other@spam.example" })],
    });
    const out = await f.service.apply(q({ ruleId: "r1" }));
    // deals@ is won by the address rule r22, so r1 only gets other@.
    expect(out.totals.matched).toBe(1);
    expect(out.byRule[0].byAccount[0].sample[0].fromAddress).toBe("other@spam.example");
  });

  it("H1: never moves mail whose classification the user rejected or corrected in review", async () => {
    const f = makeFixture({
      raws: [
        raw({ review: { decision: "rejected", correctedCategory: null } }),
        raw({ review: { decision: "approved", correctedCategory: "personal" } }),
        raw({ review: { decision: "approved", correctedCategory: null } }),
        raw({ review: null }),
      ],
    });
    const out = await f.service.apply(q());
    expect(out.totals.matched).toBe(2);
    expect(out.byRule[0].byAccount[0].sample.map((x) => x.rawEmailId)).toEqual(["raw0003", "raw0004"]);
  });

  it("M2: excludes a Message-ID trashed before and dragged back by hand (re-ingested)", async () => {
    const raws = [raw({ messageId: "back@spam.example" }), raw()];
    const f = makeFixture({
      raws,
      actions: [
        { rawEmailId: "rawOld", accountId: "acc1", action: "move_to_trash", status: "succeeded", messageId: "back@spam.example" },
      ],
    });
    const out = await f.service.apply(q());
    expect(out.totals).toMatchObject({ matched: 1, selected: 1 });
    expect(out.byRule[0].byAccount[0].sample[0].rawEmailId).toBe(raws[1].id);
  });

  it("buckets by the winning rule", async () => {
    const f = makeFixture({
      rules: [rule("r1", "spam.example"), rule("r22", "deals@spam.example", { matchType: "address" })],
      raws: [raw(), raw({ fromAddress: "other@spam.example" })],
    });
    const out = await f.service.apply(q());
    const counts = Object.fromEntries(out.byRule.map((r) => [r.ruleId, r.byAccount[0]?.matched ?? 0]));
    expect(counts).toEqual({ r1: 1, r22: 1 });
  });

  describe("live (dryRun=false, writes enabled)", () => {
    it("hands each account's selection to the writer and tallies outcomes", async () => {
      const raws = [raw(), raw(), raw(), raw(), raw({ accountId: "acc2" })];
      const f = makeFixture({
        raws,
        writesEnabled: true,
        accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B" }],
      });
      const move = jest.spyOn(f.writer, "moveToTrash").mockImplementation(async (accountId, targets) => ({
        accountId,
        trashMailbox: "Trash",
        error: null,
        results: targets.map((t, i) => ({
          rawEmailId: t.rawEmailId,
          uid: t.uid,
          status: (["succeeded", "skipped", "failed", "unknown"] as const)[i % 4],
          actionId: `a${t.uid}`,
          error: i % 3 === 0 ? null : "x",
          destUid: null,
        })),
      }));

      const out = await f.service.apply(q({ dryRun: "false" }));

      expect(move).toHaveBeenCalledTimes(2);
      const [accountId, targets, ctx] = move.mock.calls[0];
      expect(accountId).toBe("acc1");
      expect(ctx).toEqual({ senderRuleId: null });
      expect(targets[0]).toEqual({
        rawEmailId: "raw0001",
        uid: 1,
        uidValidity: "100",
        messageId: "m1@spam.example",
        fromAddress: "deals@spam.example",
        subject: "Deal 1",
        senderRuleId: "r1",
      });
      expect(out).toMatchObject({
        dryRun: false,
        writesEnabled: true,
        totals: { matched: 5, selected: 5, moved: 2, skipped: 1, failed: 1, unknown: 1 },
      });
    });

    it("isolates an account the writer refuses and keeps going", async () => {
      const raws = [raw(), raw({ accountId: "acc2" })];
      const f = makeFixture({
        raws,
        writesEnabled: true,
        accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B" }],
      });
      jest
        .spyOn(f.writer, "moveToTrash")
        .mockImplementationOnce(async () => {
          throw new BadRequestException("EmailAccount acc1 needs re-authorization");
        })
        .mockImplementationOnce(async (accountId, targets) => ({
          accountId,
          trashMailbox: "Trash",
          error: null,
          results: targets.map((t) => ({ rawEmailId: t.rawEmailId, uid: t.uid, status: "succeeded" as const, actionId: "a", error: null, destUid: 9 })),
        }));

      const out = await f.service.apply(q({ dryRun: "false" }));
      const [a1, a2] = out.byRule[0].byAccount;
      expect(a1).toMatchObject({ failed: 1, error: "EmailAccount acc1 needs re-authorization" });
      expect(a2).toMatchObject({ moved: 1, error: null });
    });

    it("live run through the real writer respects the MOVE refusal", async () => {
      // Real writer path up to the IMAP client: a factory that returns a
      // client lacking MOVE yields failed outcomes and writes no rows.
      const raws = [raw()];
      const f = makeFixture({ raws, writesEnabled: true });
      const client = {
        connect: jest.fn(async () => undefined),
        capabilities: new Map([["IMAP4rev1", true]]),
        logout: jest.fn(async () => undefined),
        close: jest.fn(),
      };
      f.factory.mockImplementation((() => client) as never);
      (f.db as unknown as { emailAccount: { findUnique: unknown } }).emailAccount.findUnique = jest.fn(async () => ({
        id: "acc1",
        isActive: true,
        needsReauth: false,
      }));
      f.credentials.getImapCredentials.mockResolvedValue({ kind: "password", password: "x" });

      const out = await f.service.apply(q({ dryRun: "false" }));
      expect(out.totals).toMatchObject({ selected: 1, moved: 0, failed: 1 });
      expect(out.byRule[0].byAccount[0].error).toBe("server lacks MOVE");
      expect(client.logout).toHaveBeenCalled();
    });
  });
});

describe("POST /sender-rules/apply", () => {
  let app: INestApplication;
  let fixture: ReturnType<typeof makeFixture>;

  async function boot(writesEnabled: boolean) {
    fixture = makeFixture({ raws: [raw()], writesEnabled });
    const moduleRef = await Test.createTestingModule({
      controllers: [SenderRulesApplyController],
      providers: [{ provide: SenderRulesApplyService, useValue: fixture.service }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalGuards(new ClientHeaderGuard());
    await app.init();
  }

  afterEach(async () => {
    await app?.close();
  });

  it("defaults to a dry run and returns 200 with the report", async () => {
    await boot(false);
    const res = await request(app.getHttpServer()).post("/sender-rules/apply").set("X-Email-AI-Client", "test").expect(200);
    expect(res.body).toMatchObject({ dryRun: true, writesEnabled: false, limit: 200, totals: { matched: 1 } });
    expect(fixture.factory).not.toHaveBeenCalled();
  });

  it("dryRun=false with writes disabled is 403", async () => {
    await boot(false);
    await request(app.getHttpServer())
      .post("/sender-rules/apply?dryRun=false")
      .set("X-Email-AI-Client", "test")
      .expect(403);
  });

  it("any POST without X-Email-AI-Client is 403, dry run included", async () => {
    await boot(true);
    for (const qs of ["", "?dryRun=true", "?dryRun=false"]) {
      const res = await request(app.getHttpServer()).post(`/sender-rules/apply${qs}`).expect(403);
      expect(res.body.message).toMatch(/X-Email-AI-Client/);
    }
    expect(fixture.factory).not.toHaveBeenCalled();
    expect(fixture.db.rawEmail.findMany).not.toHaveBeenCalled();
  });

  it("rejects a bad limit with 400", async () => {
    await boot(false);
    await request(app.getHttpServer()).post("/sender-rules/apply?limit=-3").set("X-Email-AI-Client", "test").expect(400);
  });
});
