/** Browser origins are exact scheme/host/port matches; no reflection or wildcard. */
export function isAllowedBrowserOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  return origin === undefined || allowedOrigins.includes(origin);
}
