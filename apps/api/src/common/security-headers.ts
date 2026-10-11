import type { Response } from 'express';

export const STRICT_API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

// Preview responses are restricted to inert/streamed media types by the
// preview services. Keep the policy narrow while allowing the Docs Hub page
// to embed the response in a same-origin frame. A CSP sandbox is deliberately
// omitted because native PDF rendering and media controls need their normal
// browsing context; default-src 'none' blocks active subresources.
export const PREVIEW_CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'";

export function applyStrictApiSecurityHeaders(response: Response): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  response.setHeader(
    'Content-Security-Policy',
    STRICT_API_CONTENT_SECURITY_POLICY,
  );
}

export function applyPreviewContentSecurityHeaders(response: Response): void {
  response.removeHeader('X-Frame-Options');
  response.setHeader(
    'Content-Security-Policy',
    PREVIEW_CONTENT_SECURITY_POLICY,
  );
}
