import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * CSRF defence. Every request other than GET/HEAD/OPTIONS must carry this
 * header (any non-empty value). A browser cannot add a custom header to a
 * cross-site request without a CORS preflight, and the API enables no
 * CORS, so a web page on another origin cannot send state-changing
 * requests to it. Local clients (the eai TUI, scripts/daily-digest.sh,
 * curl with -H) send it. Registered globally as APP_GUARD in AppModule.
 */
export const CLIENT_HEADER = 'x-email-ai-client';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireClientHeader(value: string | string[] | undefined): void {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ForbiddenException(
      'Missing X-Email-AI-Client header (required on every non-GET request)',
    );
  }
}

/** Global guard: non-GET/HEAD/OPTIONS requests need the header. */
@Injectable()
export class ClientHeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context
      .switchToHttp()
      .getRequest<{ method: string; headers: Record<string, string | string[] | undefined> }>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
    requireClientHeader(req.headers[CLIENT_HEADER]);
    return true;
  }
}
