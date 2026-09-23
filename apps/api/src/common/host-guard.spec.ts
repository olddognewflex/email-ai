import express from 'express';
import request from 'supertest';
import {
  allowedHostHeaders,
  hostHeaderMiddleware,
  isLoopbackHost,
  resolveBindHost,
} from './host-guard';

function app(bindHost: string, port = 3100) {
  const a = express();
  a.use(hostHeaderMiddleware(allowedHostHeaders(bindHost, port)));
  a.use((_req: express.Request, res: express.Response) => {
    res.json({ ok: true });
  });
  return a;
}

describe('resolveBindHost / isLoopbackHost', () => {
  it('defaults to 127.0.0.1 and honours EMAIL_AI_HOST', () => {
    expect(resolveBindHost({})).toBe('127.0.0.1');
    expect(resolveBindHost({ EMAIL_AI_HOST: '  ' })).toBe('127.0.0.1');
    expect(resolveBindHost({ EMAIL_AI_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    // The old generic name is ignored (zsh sets HOST to the machine name).
    expect(resolveBindHost({ HOST: 'my-mac.local' })).toBe('127.0.0.1');
  });

  it.each([
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['localhost', true],
    ['::1', true],
    ['[::1]', true],
    ['0.0.0.0', false],
    ['192.168.1.5', false],
    ['::', false],
  ])('%s loopback=%p', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe('allowedHostHeaders', () => {
  it('loopback bind: only 127.0.0.1:<port> and localhost:<port>', () => {
    expect([...allowedHostHeaders('127.0.0.1', 3100)].sort()).toEqual(['127.0.0.1:3100', 'localhost:3100']);
  });
  it('::1 bind also allows [::1]:<port>', () => {
    expect(allowedHostHeaders('::1', 3000).has('[::1]:3000')).toBe(true);
  });
  it('a non-loopback EMAIL_AI_HOST adds <host>:<port>', () => {
    expect(allowedHostHeaders('192.168.1.5', 3100).has('192.168.1.5:3100')).toBe(true);
    expect(allowedHostHeaders('fd00::5', 3100).has('[fd00::5]:3100')).toBe(true);
  });
});

describe('hostHeaderMiddleware', () => {
  it.each(['127.0.0.1:3100', 'localhost:3100', 'LOCALHOST:3100'])('serves Host %s', async (host) => {
    await request(app('127.0.0.1')).get('/health').set('Host', host).expect(200);
  });

  it.each([
    'evil.example:3100', // DNS rebinding
    'evil.example',
    '127.0.0.1', // wrong/missing port
    '127.0.0.1:3000',
    'localhost:3100.evil.example',
    '[::1]:3100', // not bound to ::1
  ])('rejects Host %s with 403, for GET and POST alike', async (host) => {
    const res = await request(app('127.0.0.1')).get('/health').set('Host', host).expect(403);
    expect(res.body.message).toMatch(/Host header not allowed/);
    await request(app('127.0.0.1')).post('/sender-rules/apply').set('Host', host).expect(403);
  });

  it('allows [::1]:<port> when bound to ::1', async () => {
    await request(app('::1')).get('/').set('Host', '[::1]:3100').expect(200);
  });

  it('allows the configured non-loopback host', async () => {
    await request(app('192.168.1.5')).get('/').set('Host', '192.168.1.5:3100').expect(200);
    await request(app('192.168.1.5')).get('/').set('Host', 'evil.example:3100').expect(403);
  });
});
