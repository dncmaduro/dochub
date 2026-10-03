# Production security notes

Docs Hub expects TLS to terminate at a controlled reverse proxy. Set
`NODE_ENV=production`; startup then requires a PostgreSQL URL, explicit HTTPS
web origin(s), configured Google OIDC, secure refresh cookies, and non-placeholder
32-character-or-longer signing secrets. Storage and upload staging roots must be
absolute and distinct. Keep both outside the checkout and restrict their owner and
permissions to the service account.

`WEB_ORIGIN` is a comma-separated allow-list of exact browser origins. Cookies are
HttpOnly, path-limited, expire with their server-side session, and are Secure in
production. The refresh cookie is the only browser credential sent automatically;
refresh/logout use `SameSite=Lax`, while normal mutations require an in-memory
Bearer token. This is sufficient for the current cookie-bearing endpoints, so no
generic CSRF middleware is installed. Do not set `AUTH_REFRESH_COOKIE_DOMAIN`
unless cross-subdomain delivery is deliberately required.

Set `TRUST_PROXY_HOPS` only when the API is not directly internet-reachable and
has exactly that many controlled proxies in front of it. Its safe default is 0,
which ignores client-supplied forwarded headers. Configure HSTS at the TLS proxy,
not on a plaintext upstream. The API emits `nosniff`, no-referrer,
frame-denial, permissions, and restrictive API CSP headers. The web server should
also send a matching site CSP that permits the configured ONLYOFFICE document
server in `frame-src`; Docs Hub itself should use `frame-ancestors 'none'`.

The API has bounded JSON bodies and streaming multipart upload limits. Targeted
in-memory rate limits protect login/callback, refresh/logout, public shares,
search/directory lookup, uploads, preview/editor session creation, and sharing
mutations. This limiter is intentionally for a single API instance. A future
multi-instance deployment needs a shared, trusted limiter before relying on those
limits.

ONLYOFFICE and Tika URLs are configuration-only trust boundaries. ONLYOFFICE
public URLs must be HTTPS in production; callback artifact fetches are exact-origin
locked and redirects are rejected. Do not point these settings at untrusted hosts.
Unknown server errors return a generic 500 and production logs intentionally omit
unknown error payloads. Never log request authorization headers, cookies, bearer
URLs, OIDC callback query strings, document contents, or secret values.
