import { createHash, randomBytes } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';

/** The URL is returned once; only tokenHash may be persisted. */
export function createShareLinkSecret(webOrigin: string | undefined): {
  tokenHash: string;
  url: string;
} {
  let origin: URL;
  try {
    origin = new URL(webOrigin ?? '');
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      !/^\/*$/.test(origin.pathname)
    )
      throw new Error('Invalid origin');
  } catch {
    throw new ServiceUnavailableException(
      'WEB_ORIGIN must be an HTTP(S) origin to create share links',
    );
  }
  const token = randomBytes(32).toString('base64url');
  return {
    tokenHash: createHash('sha256').update(token).digest('hex'),
    url: `${origin.origin}/share/${token}`,
  };
}
