import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { readFileSync } from 'fs';
import { join } from 'path';
import { appProviders } from '../app.providers';
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

  // AppModule itself is not imported: its ConfigModule validates the env at
  // import time, which throws in CI (no .env) and crashes the jest worker.
  it('is registered globally (APP_GUARD) via appProviders in AppModule', () => {
    expect(appProviders).toContainEqual({ provide: APP_GUARD, useClass: ClientHeaderGuard });
    const appModuleSource = readFileSync(join(__dirname, '..', 'app.module.ts'), 'utf8');
    expect(appModuleSource).toMatch(/providers:\s*appProviders/);
  });
});
