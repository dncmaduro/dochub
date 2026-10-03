import { describe, expect, it, vi } from 'vitest';
import { RequestRateLimitMiddleware } from './request-rate-limit.middleware.js';

describe('RequestRateLimitMiddleware', () => {
  it('limits sensitive paths per client and leaves other paths alone', () => {
    const middleware = new RequestRateLimitMiddleware();
    const response = {
      setHeader: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();
    const request = { path: '/auth/refresh', method: 'POST', ip: '127.0.0.1' };
    for (let index = 0; index < 30; index += 1)
      middleware.use(request as never, response as never, next);
    expect(next).toHaveBeenCalledTimes(30);
    middleware.use(request as never, response as never, next);
    expect(response.status).toHaveBeenCalledWith(429);

    middleware.use(
      { path: '/health', method: 'GET', ip: '127.0.0.1' } as never,
      response as never,
      next,
    );
    expect(next).toHaveBeenCalledTimes(31);
  });
});
