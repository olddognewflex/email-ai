import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ReviewQueueController } from "./review-queue.controller";
import { ReviewQueueService } from "./review-queue.service";
import { ReviewController } from "./review.controller";

describe("Review queue window query params", () => {
  let app: INestApplication;
  const listResult = (since: Date | null, days: number | null) => ({
    items: [],
    pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    window: { since: since ? since.toISOString() : null, days },
  });
  const service = {
    getReviewQueue: jest.fn(),
    getActionableQueue: jest.fn(),
    getClassificationDetail: jest.fn(),
    getNextPendingId: jest.fn(),
    approveClassification: jest.fn(),
    rejectClassification: jest.fn(),
  };
  const detail = {
    id: "c1",
    category: "receipt",
    importance: "low",
    urgency: "none",
    recommendedAction: "archive",
    confidence: "low",
    reason: "because",
    needsReview: true,
    providerUsed: null,
    createdAt: new Date(2026, 8, 20),
    reviewDecision: null,
    rule: { category: null, confidence: null, reasons: [] },
    email: {
      subject: "Hello",
      fromAddress: "a@example.com",
      fromName: null,
      toAddresses: [],
      ccAddresses: [],
      date: new Date(2026, 8, 20),
      attachmentCount: 0,
      unsubscribeLink: null,
      senderDomain: "example.com",
      accountLabel: null,
      isNewsletter: false,
      isBulk: false,
      tags: [],
    },
    body: { text: "", html: "<p>hi</p>" },
  };
  const item = {
    classification: { id: "c1", category: "receipt", confidence: "low" },
    email: {
      subject: "Hello",
      fromAddress: "a@example.com",
      fromName: null,
      accountLabel: null,
      unsubscribeLink: null,
    },
  };

  beforeAll(async () => {
    jest.useFakeTimers({
      now: new Date(2026, 8, 23, 15, 30),
      doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval"],
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [ReviewQueueController, ReviewController],
      providers: [{ provide: ReviewQueueService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service.getReviewQueue.mockImplementation((_p, _l, _c, w) =>
      Promise.resolve(listResult(w.since, w.days)),
    );
    service.getActionableQueue.mockImplementation((_p, _l, w) =>
      Promise.resolve(listResult(w.since, w.days)),
    );
    service.getClassificationDetail.mockResolvedValue(detail);
    service.approveClassification.mockResolvedValue({});
    service.rejectClassification.mockResolvedValue({});
  });

  describe("GET /review-queue", () => {
    it("applies the default 14-day window and returns it", async () => {
      const res = await request(app.getHttpServer())
        .get("/review-queue")
        .expect(200);

      const since = new Date(2026, 8, 9);
      expect(service.getReviewQueue).toHaveBeenCalledWith(1, 20, undefined, {
        since,
        days: 14,
      });
      expect(res.body).toMatchObject({
        success: true,
        data: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        window: { since: since.toISOString(), days: 14 },
      });
    });

    it("passes days, since and all through with precedence", async () => {
      const server = app.getHttpServer();
      await request(server).get("/review-queue?days=3").expect(200);
      await request(server)
        .get("/review-queue?days=3&since=2026-09-01")
        .expect(200);
      await request(server)
        .get("/review-queue?days=3&since=2026-09-01&all=true")
        .expect(200);

      const windows = service.getReviewQueue.mock.calls.map((c) => c[3]);
      expect(windows).toEqual([
        { since: new Date(2026, 8, 20), days: 3 },
        { since: new Date(2026, 8, 1), days: null },
        { since: null, days: null },
      ]);
    });

    it.each(["days=0", "days=-2", "days=1.5", "days=x", "since=2026-9-1", "since=nope"])(
      "rejects %s with 400",
      async (qs) => {
        await request(app.getHttpServer())
          .get(`/review-queue?${qs}`)
          .expect(400);
        expect(service.getReviewQueue).not.toHaveBeenCalled();
      },
    );
  });

  describe("GET /review-queue/actionable", () => {
    it("applies the default window and returns it", async () => {
      const res = await request(app.getHttpServer())
        .get("/review-queue/actionable")
        .expect(200);

      expect(service.getActionableQueue).toHaveBeenCalledWith(1, 20, {
        since: new Date(2026, 8, 9),
        days: 14,
      });
      expect(res.body.window).toEqual({
        since: new Date(2026, 8, 9).toISOString(),
        days: 14,
      });
    });

    it("honours all=true", async () => {
      await request(app.getHttpServer())
        .get("/review-queue/actionable?all=true")
        .expect(200);
      expect(service.getActionableQueue).toHaveBeenCalledWith(1, 20, {
        since: null,
        days: null,
      });
    });

    it("rejects invalid days with 400", async () => {
      await request(app.getHttpServer())
        .get("/review-queue/actionable?days=0")
        .expect(400);
    });
  });

  describe("GET /review (HTML)", () => {
    it("shows the default window with a show-all link", async () => {
      const res = await request(app.getHttpServer()).get("/review").expect(200);

      expect(res.text).toContain(
        "Showing mail received since 2026-09-09 (last 14 days)",
      );
      expect(res.text).toContain('<a href="/review?all=true">show all</a>');
    });

    it("shows all mail and keeps the window in nav links", async () => {
      const res = await request(app.getHttpServer())
        .get("/review/actionable?all=true")
        .expect(200);

      expect(service.getActionableQueue).toHaveBeenCalledWith(1, 50, {
        since: null,
        days: null,
      });
      expect(res.text).toContain("Showing all mail");
      expect(res.text).toContain('<a href="/review?all=true">Needs review</a>');
    });

    it("passes an explicit since through", async () => {
      const res = await request(app.getHttpServer())
        .get("/review?since=2026-09-01")
        .expect(200);

      expect(service.getReviewQueue).toHaveBeenCalledWith(1, 50, undefined, {
        since: new Date(2026, 8, 1),
        days: null,
      });
      expect(res.text).toContain("Showing mail received since 2026-09-01 ·");
      expect(res.text).toContain(
        '<a href="/review/actionable?since=2026-09-01">Actionable</a>',
      );
    });

    it("rejects an invalid since with 400 without echoing markup", async () => {
      const res = await request(app.getHttpServer())
        .get("/review?since=%3Cscript%3E")
        .expect(400);
      expect(service.getReviewQueue).not.toHaveBeenCalled();
      expect(res.headers["content-type"]).toMatch(/json/);
    });
  });

  describe("window carried through HTML navigation and decisions", () => {
    const withItems = (w: { since: Date | null; days: number | null }) => ({
      ...listResult(w.since, w.days),
      items: [item],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
    });

    it("default window emits no extra params", async () => {
      service.getReviewQueue.mockImplementation((_p, _l, _c, w) =>
        Promise.resolve(withItems(w)),
      );
      service.getNextPendingId.mockResolvedValue(null);
      const server = app.getHttpServer();

      const list = await request(server).get("/review").expect(200);
      expect(list.text).toContain('<a href="/review/c1">Hello</a>');
      expect(list.text).toContain('<a href="/review/actionable">Actionable</a>');

      const page = await request(server).get("/review/c1").expect(200);
      expect(page.text).toContain('<a href="/review">← Back to review queue</a>');
      expect(page.text).toContain('href="/review/c1/approve"');

      await request(server)
        .get("/review/c1/approve")
        .expect(302)
        .expect("Location", "/review");
      expect(service.getNextPendingId).toHaveBeenCalledWith({
        since: new Date(2026, 8, 9),
        days: 14,
      });
    });

    it("row links carry the window, combined with from=actionable", async () => {
      service.getActionableQueue.mockImplementation((_p, _l, w) =>
        Promise.resolve(withItems(w)),
      );
      service.getReviewQueue.mockImplementation((_p, _l, _c, w) =>
        Promise.resolve(withItems(w)),
      );
      const server = app.getHttpServer();

      const actionable = await request(server)
        .get("/review/actionable?all=true")
        .expect(200);
      expect(actionable.text).toContain(
        '<a href="/review/c1?from=actionable&amp;all=true">Hello</a>',
      );

      const review = await request(server).get("/review?days=3").expect(200);
      expect(review.text).toContain('<a href="/review/c1?days=3">Hello</a>');
    });

    it("detail back, decision and image links carry the window", async () => {
      const server = app.getHttpServer();

      const page = await request(server)
        .get("/review/c1?from=actionable&since=2026-09-01")
        .expect(200);
      expect(page.text).toContain(
        '<a href="/review/actionable?since=2026-09-01">← Back to actionable</a>',
      );
      expect(page.text).toContain(
        'href="/review/c1/approve?from=actionable&amp;since=2026-09-01"',
      );
      expect(page.text).toContain(
        'href="/review/c1/reject?category=receipt&amp;from=actionable&amp;since=2026-09-01"',
      );
      expect(page.text).toContain(
        'href="/review/c1?images=1&amp;from=actionable&amp;since=2026-09-01"',
      );

      const all = await request(server).get("/review/c1?all=true").expect(200);
      expect(all.text).toContain('<a href="/review?all=true">← Back to review queue</a>');
    });

    it("approve-and-next under all=true keeps all=true when a next item exists", async () => {
      service.getNextPendingId.mockResolvedValue("c2");

      await request(app.getHttpServer())
        .get("/review/c1/approve?all=true")
        .expect(302)
        .expect("Location", "/review/c2?all=true");
      expect(service.approveClassification).toHaveBeenCalledWith("c1");
      expect(service.getNextPendingId).toHaveBeenCalledWith({
        since: null,
        days: null,
      });
    });

    it("approve-and-next under all=true keeps all=true in the empty fallback", async () => {
      service.getNextPendingId.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get("/review/c1/approve?all=true")
        .expect(302)
        .expect("Location", "/review?all=true");
    });

    it("reject-and-next keeps since, and actionable returns to its list", async () => {
      service.getNextPendingId.mockResolvedValue(null);
      const server = app.getHttpServer();

      await request(server)
        .get("/review/c1/reject?category=receipt&since=2026-09-01")
        .expect(302)
        .expect("Location", "/review?since=2026-09-01");
      expect(service.rejectClassification).toHaveBeenCalledWith("c1", "receipt");

      await request(server)
        .get("/review/c1/reject?from=actionable&days=3")
        .expect(302)
        .expect("Location", "/review/actionable?days=3");
    });

    it("rejects an invalid window before recording a decision", async () => {
      await request(app.getHttpServer())
        .get("/review/c1/approve?days=0")
        .expect(400);
      expect(service.approveClassification).not.toHaveBeenCalled();
    });
  });
});
