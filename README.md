
A Trust Valut document : upload files with a title, description and category, search and filter them, share them with other registered users as **read** or **edit**, and review a per-user activity log. Built with Python's standard library (HTTP server + SQLite) and a dependency-free JavaScript front end. Access rules are enforced by the server on every request.

## What's inside
Six sidebar sections after sign-in:

| Section | What it does |
|---|---|
| Dashboard | Counts (owned, shared with me, categories, storage), recent documents, recent activity |
| My Documents | Everything you can access, with tabs for *All / Owned by me / Shared with me*, title search and a category filter |
| Search Documents | Filter by title or filename, category, owner (username/name/email) and upload date |
| Categories | General, Personal, Identity, Financial, Legal, Medical, Education, Work — with counts; click one to filter |
| Upload Document | Title, description, category and file (PDF, TXT, PNG, JPEG; max 5 MB; drag-and-drop supported) |
| Activity Logs | Your actions plus activity on documents you own (including blocked attempts); administrators see everything |

Open a document to download it, edit its details (owner or edit access), delete it (owner or admin) or manage who can access it (owner).

Sign-in accepts a **username or an email**. New accounts choose a username on the sign-up form; accounts created before this version have no username and keep signing in with their email.

## Requirements
- Python 3.11+ (developed and tested on 3.12). No third-party packages.
- Optional, for the browser test only: `pip install playwright && playwright install chromium`.

## Run locally

```bash
python app.py
```

Open http://localhost:8000.

The server creates `data/mono.sqlite` and stores uploads in `private_uploads/`. Uploads are not served as static files; downloads go through an authenticated endpoint. Existing databases from earlier versions are upgraded automatically on startup (new columns/tables are added; no data is removed, old documents get their file name as title and the *General* category).

## Configuration

Optional environment variables:

- `PORT` — server port (default `8000`).
- `DB_PATH` — SQLite database path.
- `UPLOAD_DIR` — private file directory.
- `MAX_UPLOAD_BYTES` — maximum upload size.
- `APP_SECRET` — long random signing secret. The default is for local development only.
- `APP_ENV=production` — enables the `Secure` cookie attribute. Production must use HTTPS.

Example for a local shell:

```bash
APP_SECRET="replace-with-a-long-random-secret" python app.py
```

Do not use the development secret in production. This dependency-free HTTP server is intended as a local demonstration/starter, not a substitute for a hardened production deployment behind HTTPS and a maintained application framework.

## Permissions model
- **Owner**: everything — view, download, edit details, delete, share, revoke.
- **Edit access** (granted by the owner): view, download and edit title/description/category. Edit always includes read. It never allows delete or re-sharing.
- **Read access**: view and download only.
- **Administrator**: read and delete any document and read all activity logs. Cannot edit or re-share other people's documents.
- Anyone else gets `403`. Denied attempts are written to the activity log and are visible to the document's owner.

The "Select user" list in the sharing form shows the name/username and email of every other registered user (this is how the picker works in your demo). If that is too open for your deployment, replace it with an invite-by-email flow.

## API endpoints
See `docs/api.md` for the full reference. Summary:

- `GET /api/health`
- `POST /api/auth/signup`, `POST /api/auth/signin` (username or email), `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/users`, `GET /api/categories`
- `GET /api/documents` (filters: `scope`, `q`, `category`, `owner`, `date`, `tz`), `POST /api/documents` (multipart)
- `GET|PATCH|DELETE /api/documents/:id`, `GET /api/documents/:id/download`
- `POST /api/documents/:id/permissions`, `DELETE /api/documents/:id/permissions/:userId`
- `GET /api/audit-logs`

Passwords are hashed with PBKDF2-HMAC-SHA256. SQL uses placeholders. Authentication uses a signed, HttpOnly, SameSite cookie. The Content-Security-Policy forbids inline scripts/styles, so the UI uses only same-origin files and system fonts.

## Run tests

```bash
python -m unittest discover -s tests -v          # 12 backend/API integration tests (no extra packages)
python tests/e2e_ui.py                           # optional browser test, needs Playwright + Chromium
```

The backend tests launch an isolated server with a temporary database. They cover auth (username/email), validation, upload metadata, categories, every search filter, read/edit/revoke sharing, cross-user denial, activity-log scoping, and in-place migration of an old database. The browser test drives two users through the real UI at desktop and phone widths.

## Known limitations
- No rate limiting or account lockout on sign-in, and no password reset or email verification.
- No file versioning or in-place file replacement (edit access changes details only).
- Sessions last 8 hours; role changes need a fresh sign-in to appear in the cookie (the server itself re-reads the role from the database on every request).
- Single-process server with SQLite: fine for a demo or small team, not a hardened production deployment. Use HTTPS, a real secret and a maintained framework before holding confidential data.
- Searching by date uses the browser's time zone offset; documents are stored in UTC.

## Making an administrator (local testing)

Administrators can read every activity log and can read or delete any document (they cannot edit or re-share other people's files). For a local-only test, sign up an account first, then promote it directly in SQLite:

```bash
python - <<'PY'
import sqlite3
connection = sqlite3.connect('data/mono.sqlite')
connection.execute("UPDATE users SET role='admin' WHERE email=?", ('your-email@example.com',))
connection.commit()
connection.close()
PY
```

Sign out and sign in again so the new role is included in the session token. Do not expose this manual database operation as a public endpoint.
