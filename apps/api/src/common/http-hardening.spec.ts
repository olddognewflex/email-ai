import { Controller, Get, Module, Post } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import request from 'supertest';
import { ClientHeaderGuard } from './client-header';
import { allowedHostHeaders, hostHeaderMiddleware } from './host-guard';

@Controller('x')
class ProbeController {
  @Get()
  get() {
    return { ok: true };
  }

  @Post()
  post() {
    return { ok: true };
  }
}

@Module({
  controllers: [ProbeController],
  providers: [{ provide: APP_GUARD, useClass: ClientHeaderGuard }],
})
class ProbeModule {}

/** Wired the way main.ts and AppModule wire it. */
describe('HTTP hardening as wired in a Nest app', () => {
  it('Host middleware runs before routing; the global guard gates POST', async () => {
    const app = await NestFactory.create(ProbeModule, { logger: false });
    app.use(hostHeaderMiddleware(allowedHostHeaders('127.0.0.1', 3100)));
    await app.init();
    const server = app.getHttpServer();
    try {
      await request(server).get('/x').set('Host', 'evil.example:3100').expect(403);
      await request(server).post('/x').set('Host', 'evil.example:3100').set('X-Email-AI-Client', 't').expect(403);
      await request(server).get('/x').set('Host', '127.0.0.1:3100').expect(200);
      await request(server).post('/x').set('Host', '127.0.0.1:3100').expect(403);
      await request(server).post('/x').set('Host', 'localhost:3100').set('X-Email-AI-Client', 't').expect(201);
    } finally {
      await app.close();
    }
  });
});
