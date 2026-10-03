import { describe, expect, it } from 'vitest';
import { isAllowedBrowserOrigin } from './cors-policy.js';

describe('isAllowedBrowserOrigin', () => {
  const origins = ['https://app.example.test'];

  it('allows configured browser origins and non-browser server requests', () => {
    expect(isAllowedBrowserOrigin('https://app.example.test', origins)).toBe(
      true,
    );
    expect(isAllowedBrowserOrigin(undefined, origins)).toBe(true);
  });

  it('denies arbitrary origins instead of reflecting them', () => {
    expect(isAllowedBrowserOrigin('https://attacker.example', origins)).toBe(
      false,
    );
    expect(
      isAllowedBrowserOrigin('https://app.example.test.evil', origins),
    ).toBe(false);
  });
});
