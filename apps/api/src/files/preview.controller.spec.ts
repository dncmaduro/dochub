import { describe, expect, it, vi } from 'vitest';
import { PREVIEW_CONTENT_SECURITY_POLICY } from '../common/security-headers.js';
import { PreviewController } from './preview.controller.js';

describe('PreviewController', () => {
  it('overrides strict frame headers for legacy preview content', async () => {
    const previews = {
      cookieName: vi.fn().mockReturnValue('preview-cookie'),
      verify: vi.fn().mockResolvedValue({ nid: 'node', vid: 'version' }),
    };
    const reads = {
      openAuthorized: vi.fn().mockResolvedValue({ stream: {} }),
      write: vi.fn(),
    };
    const response = {
      removeHeader: vi.fn(),
      setHeader: vi.fn(),
    };
    const request = {
      cookies: { 'preview-cookie': 'capability' },
      header: vi.fn().mockReturnValue(undefined),
    };
    const controller = new PreviewController(previews as never, {} as never, reads as never);

    await controller.content('session', request as never, response as never);

    expect(response.removeHeader).toHaveBeenCalledWith('X-Frame-Options');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Security-Policy',
      PREVIEW_CONTENT_SECURITY_POLICY,
    );
  });
});
