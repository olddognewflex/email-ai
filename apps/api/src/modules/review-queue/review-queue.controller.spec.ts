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
});
