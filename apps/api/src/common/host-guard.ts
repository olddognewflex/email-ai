import type { NextFunction, Request, Response } from 'express';
import { isIP } from 'net';

/**
 * DNS-rebinding defence. A page on evil.example can re-point its own
 * hostname at 127.0.0.1 and then make same-origin requests to this API;
 * those arrive with `Host: evil.example:<port>`. Only requests whose Host
 * header names this server exactly are served.
 */

export const DEFAULT_BIND_HOST = '127.0.0.1';

/** EMAIL_AI_HOST, or 127.0.0.1. */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['EMAIL_AI_HOST']?.trim();
  return v ? v : DEFAULT_BIND_HOST;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** `host:port`, bracketing an IPv6 literal. */
function hostPort(host: string, port: number | string): string {
  const h = host.replace(/^\[|\]$/g, '');
  return `${isIP(h) === 6 ? `[${h}]` : h}:${port}`.toLowerCase();
}

/**
 * Host header values served for a bind address:
 * - always `127.0.0.1:<port>` and `localhost:<port>`;
 * - `[::1]:<port>` only when bound to ::1;
 * - `<bind host>:<port>` when EMAIL_AI_HOST is a non-loopback address.
 */
export function allowedHostHeaders(bindHost: string, port: number | string): Set<string> {
  const allowed = new Set([hostPort('127.0.0.1', port), hostPort('localhost', port)]);
  const bare = bindHost.replace(/^\[|\]$/g, '');
  if (bare === '::1') allowed.add(hostPort('::1', port));
  else if (!isLoopbackHost(bare)) allowed.add(hostPort(bare, port));
  return allowed;
}

export function hostHeaderMiddleware(allowed: ReadonlySet<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = (req.headers.host ?? '').trim().toLowerCase();
    if (allowed.has(host)) {
      next();
      return;
    }
    res.status(403).json({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Host header not allowed (this API only answers to its own local address)',
    });
  };
}
