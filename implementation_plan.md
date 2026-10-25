# Implementation Plan — MONO Challenge

## Requirement verification boundary
The public Snovasys event page confirms the submission requires a public GitHub repository and live website, and emphasizes server-enforced permissions, real data flow, audit trail, error handling, tests, and deployment. The full project-specific problem statement is not visible without challenge login. The document-management implementation is therefore a provisional interpretation and must be checked against `docs/official_requirements.md` before final submission.

## Implemented architecture
- Frontend: semantic HTML5, CSS3, and vanilla JavaScript, served as same-origin static assets.
- Backend: Python standard-library `ThreadingHTTPServer` and JSON REST endpoints.
- Database: SQLite via Python's built-in `sqlite3` module.
- Password hashing: PBKDF2-HMAC-SHA256 with per-user random salt.
- Authentication: signed, expiring, HttpOnly, SameSite cookie; Secure attribute enabled in production mode.
- File storage: private server directory; file bytes are not served as static assets.
- Tests: Python `unittest` integration tests that launch an isolated local server and temporary database.

## Environment limitation
An initial React/Express dependency install was attempted but the package registry could not resolve (`EAI_AGAIN`). To deliver a runnable and testable application rather than claim uninstalled dependencies, the unused React/Express draft was replaced with a dependency-free implementation. If the official challenge requires a specific framework, migrate when package-registry access is available.

## Data model
- `users`: id, name, normalized unique email, password hash, role, created timestamp.
- `documents`: id, owner id, sanitized original name, generated storage name, MIME type, size, created timestamp.
- `audit_logs`: actor id, action, resource type/id, outcome, JSON details, timestamp.

## API contracts
- `GET /api/health`: service health.
- `POST /api/auth/signup`: create account, set session cookie; 201/400/409.
- `POST /api/auth/signin`: authenticate, set session cookie; 200/400/401.
- `POST /api/auth/logout`: clear session cookie; 204.
- `GET /api/auth/me`: current user; 200/401.
- `GET /api/documents`: list caller's documents; 200/401.
- `POST /api/documents`: authenticated multipart upload; 201/400/401/413.
- `GET /api/documents/:id/download`: owner/admin-only download; 200/403/404.
- `DELETE /api/documents/:id`: owner/admin-only delete; 204/403/404.
- `GET /api/audit-logs`: admin-only audit log; 200/403/401.

## Component hierarchy
- App shell: header, route content, footer.
- Public views: Home, Sign In, Sign Up, About.
- Authenticated view: Workspace dashboard with document list, upload, download, and delete.
- Shared frontend behavior: API helper, form validation, status messages, file formatting, navigation.

## UI design system
- Black `#000000`, white `#FFFFFF`, neutral gray `#737373`, light border `#E5E5E5`, dark border `#262626`.
- Home is black with white type and controls. Sign In, Sign Up, About, and Workspace are white with black type.
- Responsive layout, visible keyboard focus, semantic labels, no colorful gradients, no unnecessary visual clutter.

## Security controls
- Server validates signup, login, upload sizes, MIME type, extension, file signatures, and filenames.
- Passwords are never stored in plain text.
- SQL queries use placeholders.
- File storage names are random; original filenames are not used as paths.
- Protected endpoints authenticate each request and check document ownership or admin role.
- Private uploads are never exposed by static serving.
- Session cookie is HttpOnly and SameSite=Lax; production mode adds Secure and requires a strong secret.
- Security headers include CSP, frame denial, and `nosniff`.
- Audit events cover signup, sign-in attempts, logout, upload, download, deletion, and denied resource access.

## Test strategy
Integration tests exercise health, registration, duplicate email, validation, current-user endpoint, protected routes, upload/list/download/delete, and cross-user access denial. Run `python -m unittest discover -s tests -v`.

## Deployment
Local start: `python app.py`. Before production, use HTTPS, a strong `APP_SECRET`, persistent SQLite/upload storage, and preferably a maintained application framework/reverse proxy. No public deployment is claimed until credentials and a deployment platform are available.
