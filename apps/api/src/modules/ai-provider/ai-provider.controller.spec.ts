import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AiProviderController } from "./ai-provider.controller";
import { AiProviderService } from "./ai-provider.service";

describe("AiProviderController", () => {
  let app: INestApplication;
  const service = {
    getBreakerStatus: jest.fn(),
    getConfig: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AiProviderController],
      providers: [{ provide: AiProviderService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => jest.clearAllMocks());

  describe("GET /ai-providers/breaker", () => {
    it("returns breaker status instead of matching :id", async () => {
      service.getBreakerStatus.mockReturnValue({
        open: true,
        nextAllowedAttempt: "2026-09-22T20:00:00.000Z",
        reason: "quota",
      });

      const res = await request(app.getHttpServer())
        .get("/ai-providers/breaker")
        .expect(200);

      expect(res.body).toEqual({
        open: true,
        nextAllowedAttempt: "2026-09-22T20:00:00.000Z",
        reason: "quota",
      });
      expect(service.getConfig).not.toHaveBeenCalled();
    });

    it("reports a closed breaker", async () => {
      service.getBreakerStatus.mockReturnValue({ open: false });

      const res = await request(app.getHttpServer())
        .get("/ai-providers/breaker")
        .expect(200);

      expect(res.body).toEqual({ open: false });
    });

    it("still routes other ids to getConfig", async () => {
      service.getConfig.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get("/ai-providers/some-id")
        .expect(200);

      expect(service.getConfig).toHaveBeenCalledWith("some-id");
      expect(service.getBreakerStatus).not.toHaveBeenCalled();
    });
  });
});
