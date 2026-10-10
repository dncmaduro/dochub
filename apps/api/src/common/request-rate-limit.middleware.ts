import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

interface Limit {
  windowMs: number;
  max: number;
}
interface Entry {
  count: number;
  resetAt: number;
}

const MINUTE = 60_000;
const SENSITIVE_ROUTES: ReadonlyArray<{
  match: (request: Request) => boolean;
  limit: Limit;
}> = [
  {
    match: (r) =>
      r.path === '/auth/google' || r.path === '/auth/google/callback',
    limit: { windowMs: 10 * MINUTE, max: 20 },
  },
  {
    match: (r) => r.path === '/auth/refresh' || r.path === '/auth/logout',
    limit: { windowMs: MINUTE, max: 30 },
  },
  {
    match: (r) => r.path.startsWith('/documents/'),
    limit: { windowMs: MINUTE, max: 120 },
  },
  {
    match: (r) => r.path === '/search' || r.path === '/sharing/principals',
    limit: { windowMs: MINUTE, max: 60 },
  },
  {
    match: (r) =>
      /^\/nodes\/[^/]+\/(?:preview-session|editor-sessions|sharing)$/.test(
        r.path,
      ) ||
      /^\/nodes\/[^/]+\/drive-preview-session$/.test(r.path) ||
      r.path === '/files' ||
      /^\/nodes\/[^/]+\/versions$/.test(r.path),
    limit: { windowMs: MINUTE, max: 30 },
  },
];

/** A bounded in-process limiter for one API instance. It intentionally has no
 * Redis dependency; deploy a shared limiter before running multiple instances. */
@Injectable()
export class RequestRateLimitMiddleware implements NestMiddleware {
  private readonly entries = new Map<string, Entry>();

  use(request: Request, response: Response, next: NextFunction): void {
    const rule = SENSITIVE_ROUTES.find(({ match }) => match(request));
    if (!rule) return next();
    const now = Date.now();
    if (this.entries.size > 10_000) {
      for (const [key, entry] of this.entries)
        if (entry.resetAt <= now) this.entries.delete(key);
    }
    const key = `${request.ip}:${request.method}:${rule.limit.windowMs}:${request.path}`;
    // Public document paths contain UUID locators. Keep the limiter itself
    // bounded when callers probe many different document IDs.
    if (this.entries.size >= 10_000 && !this.entries.has(key)) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey) this.entries.delete(oldestKey);
    }
    const existing = this.entries.get(key);
    const entry =
      !existing || existing.resetAt <= now
        ? { count: 1, resetAt: now + rule.limit.windowMs }
        : { ...existing, count: existing.count + 1 };
    this.entries.set(key, entry);
    if (entry.count > rule.limit.max) {
      response
        .setHeader(
          'Retry-After',
          String(Math.ceil((entry.resetAt - now) / 1000)),
        )
        .status(429)
        .json({ statusCode: 429, message: 'Too many requests' });
      return;
    }
    next();
  }
}
