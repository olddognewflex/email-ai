import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ClientHeaderGuard } from './client-header';

const ctx = (method: string, headers: Record<string, string> = {}) =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
  }) as unknown as ExecutionContext;

describe('ClientHeaderGuard', () => {
  const guard = new ClientHeaderGuard();

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('lets %s through without the header', (m) => {
    expect(guard.canActivate(ctx(m))).toBe(true);
  });

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('requires the header on %s', (m) => {
    expect(() => guard.canActivate(ctx(m))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx(m, { 'x-email-ai-client': ' ' }))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctx(m, { 'x-email-ai-client': 'eai-tui' }))).toBe(true);
  });

  it('is registered globally (APP_GUARD) in AppModule', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as { provide?: unknown; useClass?: unknown }[];
    expect(providers).toContainEqual({ provide: APP_GUARD, useClass: ClientHeaderGuard });
  });
});
