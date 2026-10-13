# Security

## Reporting

This is a portfolio project without a security team. If you find a vulnerability, open a private report with the
repository owner (Robert Ramos) rather than a public issue. Include reproduction steps and the affected version.

## Threat model and controls

| Concern | Control |
| --- | --- |
| Password theft from the DB | scrypt (N=16384, r=8, p=1, 64-byte key, 16-byte random salt, NFKC-normalized input). Parameters are stored per hash and upgraded on the next login |
| Account enumeration | Unknown users and wrong passwords return the same message. Unknown users still pay a dummy scrypt verification. Auth endpoints are rate limited per IP |
| Token forgery / algorithm confusion | HS256 only (the `alg` header must equal `HS256`), constant-time signature comparison, issuer/type/expiry checks with ±30 s skew |
| Stolen access tokens | 15-minute lifetime, bound to a session id that is checked on every request, so logout revokes immediately |
| Stolen refresh tokens | Only SHA-256 hashes are stored. Every refresh rotates the token, and presenting a rotated token revokes the whole session (reuse detection) and closes its sockets |
| Broken access control | Every service method calls `AccessControl` with a named action from the shared permission table. Non-members get `404` (no existence leaks). WebSocket ops are re-checked against the *current* role, which is updated live on membership changes |
| Replica spoofing over WS | The server assigns each connection its CRDT site id. Ops for other sites, out-of-order sequences, clock jumps (`clock > lamport + 1`) and over-size documents are rejected |
| Injection | All SQL uses bound parameters. User text is rendered by React (no `innerHTML`), and mentions are highlighted by splitting strings |
| XSS impact | CSP `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, COOP/CORP |
| CSRF / cross-site WebSocket hijacking | The API uses bearer tokens (no cookies). CORS is an explicit allow-list. WebSocket upgrades with a foreign `Origin` are refused with 403 |
| Resource exhaustion | Body limit (1 MiB) checked before reading; WS frame limit 256 KiB; per-IP, per-auth and per-socket token buckets; per-user connection cap; slow-consumer termination by buffered bytes; request and header timeouts; 500 000-character document cap; bounded CRDT pending buffer |
| Path traversal (static files) | Paths are resolved and confined to the static root. Malformed encodings and NUL bytes are rejected |
| Secrets in logs | The logger redacts `password`, `token`, `accessToken`, `refreshToken`, `authorization` and `secret` fields. Tokens are never logged |
| Misconfiguration | Config is schema-validated. Production refuses to start without a real `JWT_SECRET` (at least 32 characters). `/metrics` can require a token. HSTS is opt-in for HTTPS deployments |

## Known gaps

- The refresh token is kept in `localStorage`, so a successful XSS could exfiltrate it. A hardened deployment
  should move it to an httpOnly, `SameSite=Strict` cookie with CSRF protection (not implemented).
- An authenticated WebSocket stays open past access-token expiry until the session is revoked or membership
  changes.
- There is no e-mail verification, password reset, MFA or account lockout beyond rate limiting.
- Rate limiting and connection caps are per process. Behind a load balancer, set `TRUST_PROXY=true` only when the
  proxy overwrites `X-Forwarded-For`.
- TLS termination is expected at a reverse proxy. The server speaks plain HTTP/WS.

## Secrets handling

No secrets are committed. `.env.example` documents every variable with empty or placeholder values. The demo seed
uses synthetic users (`*@example.test`) and a password you pass on the command line.
