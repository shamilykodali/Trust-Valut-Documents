# TrustVault Threat Notes (Draft)

This is a working threat list, not a claim that every mitigation is implemented. Validate each item against the exact challenge requirements and deployed build.

| Threat | Risk | Current status / mitigation | Remaining work |
|---|---|---|---|
| IDOR | A user guesses another document ID | Server checks ownership on document operations | Implement per-user grants and test every endpoint |
| 403 vs 404 leakage | Unauthorized users learn a document exists | Some routes return not-found for missing items; verify consistency | Standardize all denied/missing document responses |
| Path traversal | Crafted filenames access other files | Storage uses server-generated names | Add adversarial tests for traversal and double extensions |
| Malicious uploads | Crafted content is stored as an unsafe file | Upload allowlist and content checks exist | Expand magic-byte tests and size-boundary tests |
| Mass assignment | Request body changes roles or ownership | Do not accept ownership/role fields from upload requests | Add explicit regression tests for unexpected fields |
| Revocation during download | Previously granted access persists | Current starter does not implement grants/revocation | Implement grant lookup on every download; define stream revocation behavior |
| Deleted documents in search | Soft-deleted documents appear in results | Search and soft-delete are not implemented | Add status filter and tests |
| Log injection | User-controlled values corrupt logs | Values should be escaped/length-limited | Add centralized log sanitization tests |
| Session fixation | Attacker reuses a known session | Session cookie is signed and HttpOnly | Rotate session on login; test fixation resistance |
| CSRF | Cross-site requests perform actions | SameSite cookie provides partial protection | Add explicit CSRF token/origin validation |
| Brute force | Login endpoint is guessed repeatedly | Rate limiting is not implemented | Add account/IP-aware rate limits and tests |

## Important limitations

The current implementation is a local Python/SQLite starter, not the requested Node.js/TypeScript, Express, PostgreSQL implementation. It does not yet implement named-user grants, edit permissions, revocation, soft deletion, search, or a tamper-evident append-only audit chain. Do not represent these as complete in a submission.
