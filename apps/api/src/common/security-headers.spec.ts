import { describe, expect, it, vi } from 'vitest';
import {
  applyPreviewContentSecurityHeaders,
  applyStrictApiSecurityHeaders,
  PREVIEW_CONTENT_SECURITY_POLICY,
  STRICT_API_CONTENT_SECURITY_POLICY,
} from './security-headers.js';

function responseDouble() {
  return {
    removeHeader: vi.fn(),
    setHeader: vi.fn(),
  } as never;
}

describe('security headers', () => {
  it('keeps normal API responses frame-denied', () => {
    const response = responseDouble();
    applyStrictApiSecurityHeaders(response);
    expect(response.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Security-Policy',
      STRICT_API_CONTENT_SECURITY_POLICY,
    );
  });

  it('allows only same-origin preview embedding and removes DENY', () => {
    const response = responseDouble();
    applyPreviewContentSecurityHeaders(response);
    expect(response.removeHeader).toHaveBeenCalledWith('X-Frame-Options');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Security-Policy',
      PREVIEW_CONTENT_SECURITY_POLICY,
    );
    expect(PREVIEW_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'self'");
    expect(PREVIEW_CONTENT_SECURITY_POLICY).not.toContain("frame-ancestors 'none'");
  });
});
