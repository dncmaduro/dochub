import { describe, expect, it, vi } from 'vitest';
import { PREVIEW_CONTENT_SECURITY_POLICY } from '../common/security-headers.js';
import { DrivePreviewController } from './drive-preview.controller.js';

describe('DrivePreviewController', () => {
  it('overrides strict frame headers for Drive preview content', async () => {
    const previews = {
      cookieName: vi.fn().mockReturnValue('drive-preview-cookie'),
      verify: vi.fn().mockResolvedValue({ nid: 'node' }),
      openContent: vi.fn().mockResolvedValue({ stream: {} }),
      write: vi.fn(),
    };
    const response = {
      removeHeader: vi.fn(),
      setHeader: vi.fn(),
    };
    const request = {
      cookies: { 'drive-preview-cookie': 'capability' },
      header: vi.fn().mockReturnValue(undefined),
    };
    const controller = new DrivePreviewController(previews as never, {} as never);

    await controller.content('session', request as never, response as never);

    expect(response.removeHeader).toHaveBeenCalledWith('X-Frame-Options');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Security-Policy',
      PREVIEW_CONTENT_SECURITY_POLICY,
    );
  });
});
