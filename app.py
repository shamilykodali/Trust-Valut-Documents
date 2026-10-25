#!/usr/bin/env python3
"""TrustVault: dependency-free secure document workspace using Python's standard library and SQLite.
For production deployment, use a maintained web framework and HTTPS reverse proxy.
"""
from __future__ import annotations
import base64, hashlib, hmac, json, mimetypes, os, re, secrets, sqlite3, threading, time
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'public'
UPLOAD_DIR = Path(os.environ.get('UPLOAD_DIR', ROOT / 'private_uploads')).resolve()
DB_PATH = Path(os.environ.get('DB_PATH', ROOT / 'data' / 'mono.sqlite')).resolve()
PORT = int(os.environ.get('PORT', '8000'))
MAX_UPLOAD = int(os.environ.get('MAX_UPLOAD_BYTES', str(5 * 1024 * 1024)))
COOKIE_NAME = 'mono_session'
SECRET = os.environ.get('APP_SECRET', 'local-development-secret-change-before-deployment').encode()
PRODUCTION = os.environ.get('APP_ENV') == 'production'
ALLOWED_TYPES = {'application/pdf', 'text/plain', 'image/png', 'image/jpeg'}
EXT_TO_MIME = {'.pdf': 'application/pdf', '.txt': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}
CATEGORIES = ['General', 'Personal', 'Identity', 'Financial', 'Legal', 'Medical', 'Education', 'Work']
USERNAME_RE = re.compile(r'[A-Za-z0-9_.-]{3,30}')
_schema_lock = threading.Lock()
_schema_ready = set()

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def _columns(db, table):
    return {row['name'] for row in db.execute(f'PRAGMA table_info({table})')}


def _init_schema(db):
    """Create tables and upgrade older databases in place (existing data is kept)."""
    db.execute('''CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )''')
    db.execute('''CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )''')
    db.execute('''CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('success','denied','failure')),
        details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )''')
    # --- additive migrations for databases created by earlier versions ---
    if 'username' not in _columns(db, 'users'):
        db.execute('ALTER TABLE users ADD COLUMN username TEXT COLLATE NOCASE')
    for column, ddl in (('title', "TEXT NOT NULL DEFAULT ''"), ('description', "TEXT NOT NULL DEFAULT ''"),
                        ('category', "TEXT NOT NULL DEFAULT 'General'")):
        if column not in _columns(db, 'documents'):
            db.execute(f'ALTER TABLE documents ADD COLUMN {column} {ddl}')
    db.execute("UPDATE documents SET title=original_name WHERE title=''")
    db.execute('''CREATE TABLE IF NOT EXISTS document_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        can_read INTEGER NOT NULL DEFAULT 1 CHECK(can_read IN (0,1)),
        can_edit INTEGER NOT NULL DEFAULT 0 CHECK(can_edit IN (0,1)),
        granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        UNIQUE(document_id, user_id)
    )''')
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_permissions_user ON document_permissions(user_id)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)')
    db.commit()


def connect_db():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys = ON')
    key = str(DB_PATH)
    if key not in _schema_ready:
        with _schema_lock:
            if key not in _schema_ready:
                _init_schema(db)
                _schema_ready.add(key)
    return db


def audit(db, actor_id, action, resource_type, resource_id=None, outcome='success', details=None):
    db.execute('INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,outcome,details_json) VALUES(?,?,?,?,?,?)',
               (actor_id, action, resource_type, None if resource_id is None else str(resource_id), outcome,
                json.dumps(details or {}, separators=(',', ':'))))


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def create_token(user_id: int, role: str) -> str:
    payload = json.dumps({'sub': user_id, 'role': role, 'exp': int(time.time()) + 8 * 3600}, separators=(',', ':')).encode()
    encoded = b64url(payload)
    signature = b64url(hmac.new(SECRET, encoded.encode(), hashlib.sha256).digest())
    return encoded + '.' + signature


def read_token(token: str):
    try:
        encoded, signature = token.split('.', 1)
        expected = b64url(hmac.new(SECRET, encoded.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected): return None
        payload = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
        if int(payload['exp']) < int(time.time()): return None
        return {'id': int(payload['sub']), 'role': payload['role']}
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 310_000)
    return f"pbkdf2_sha256$310000${b64url(salt)}${b64url(derived)}"


def password_matches(password: str, encoded: str) -> bool:
    try:
        scheme, rounds, salt_text, expected = encoded.split('$')
        if scheme != 'pbkdf2_sha256': return False
        salt = base64.urlsafe_b64decode(salt_text + '=' * (-len(salt_text) % 4))
        actual = b64url(hashlib.pbkdf2_hmac('sha256', password.encode(), salt, int(rounds)))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


class AppError(Exception):
    def __init__(self, status, message): self.status, self.message = status, message


class Handler(BaseHTTPRequestHandler):
    server_version = 'TrustVault'
    sys_version = ''

    def log_message(self, fmt, *args):
        print('[http] %s - %s' % (self.address_string(), fmt % args))

    def _headers(self, status=200, content_type='application/json; charset=utf-8', extra=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        self.send_header('Cache-Control', 'no-store' if self.path.startswith('/api/') else 'no-cache')
        for key, value in (extra or {}).items(): self.send_header(key, value)
        self.end_headers()

    def _json(self, status, payload, extra=None):
        body = b'' if status == 204 else json.dumps(payload, ensure_ascii=False).encode()
        self._headers(status, extra=extra)
        if status != 204: self.wfile.write(body)

    def _cookie(self, token=None):
        if token:
            value = f'{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800'
            if PRODUCTION: value += '; Secure'
        else:
            value = f'{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
            if PRODUCTION: value += '; Secure'
        return {'Set-Cookie': value}

    def _body(self, limit=1024 * 1024):
        try: length = int(self.headers.get('Content-Length', '0'))
        except ValueError: raise AppError(400, 'Invalid Content-Length.')
        if length < 0: raise AppError(400, 'Invalid request size.')
        if length > limit: raise AppError(413, 'Request body is too large.')
        return self.rfile.read(length)

    def _json_body(self):
        if 'application/json' not in self.headers.get('Content-Type', ''): raise AppError(415, 'Expected a JSON request.')
        try: return json.loads(self._body().decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError): raise AppError(400, 'Invalid JSON body.')

    def _user(self, db):
        cookie_header = self.headers.get('Cookie', '')
        token = None
        for item in cookie_header.split(';'):
            key, sep, value = item.strip().partition('=')
            if sep and key == COOKIE_NAME: token = value
        user = read_token(token) if token else None
        if not user: raise AppError(401, 'Please sign in to continue.')
        record = db.execute('SELECT id,name,username,email,role,created_at FROM users WHERE id=?', (user['id'],)).fetchone()
        if not record: raise AppError(401, 'Account no longer exists.')
        return dict(record)

    def do_HEAD(self):
        if self.path.startswith('/api/'):
            self._headers(405, 'application/json; charset=utf-8')
            return
        parsed = urlparse(self.path)
        route = 'index.html' if parsed.path == '/' else unquote(parsed.path).lstrip('/')
        candidate = (PUBLIC / route).resolve()
        if PUBLIC.resolve() not in candidate.parents or not candidate.is_file():
            self._headers(404, 'application/json; charset=utf-8')
            return
        mime = mimetypes.guess_type(candidate.name)[0] or 'application/octet-stream'
        self._headers(200, mime + ('; charset=utf-8' if mime.startswith(('text/', 'application/javascript')) else ''), {'Content-Length': str(candidate.stat().st_size)})

    def do_GET(self): self._dispatch('GET')
    def do_POST(self): self._dispatch('POST')
    def do_PATCH(self): self._dispatch('PATCH')
    def do_DELETE(self): self._dispatch('DELETE')

    def _dispatch(self, method):
        db = connect_db()
        try:
            parsed = urlparse(self.path)
            route = parsed.path
            self.query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            if route.startswith('/api/'):
                if method == 'GET' and route == '/api/health': return self._json(200, {'status': 'ok', 'service': 'trustvault-api'})
                if route == '/api/auth/signup' and method == 'POST': return self._signup(db)
                if route == '/api/auth/signin' and method == 'POST': return self._signin(db)
                if route == '/api/auth/logout' and method == 'POST': return self._logout(db)
                if route == '/api/auth/me' and method == 'GET': return self._me(db)
                if route == '/api/users' and method == 'GET': return self._list_users(db)
                if route == '/api/categories' and method == 'GET': return self._categories(db)
                if route == '/api/documents' and method == 'GET': return self._list_documents(db)
                if route == '/api/documents' and method == 'POST': return self._upload_document(db)
                match = re.fullmatch(r'/api/documents/(\d+)/download', route)
                if match and method == 'GET': return self._download_document(db, int(match.group(1)))
                match = re.fullmatch(r'/api/documents/(\d+)/permissions', route)
                if match and method == 'POST': return self._grant_permission(db, int(match.group(1)))
                match = re.fullmatch(r'/api/documents/(\d+)/permissions/(\d+)', route)
                if match and method == 'DELETE': return self._revoke_permission(db, int(match.group(1)), int(match.group(2)))
                match = re.fullmatch(r'/api/documents/(\d+)', route)
                if match and method == 'GET': return self._get_document(db, int(match.group(1)))
                if match and method == 'PATCH': return self._update_document(db, int(match.group(1)))
                if match and method == 'DELETE': return self._delete_document(db, int(match.group(1)))
                if route == '/api/audit-logs' and method == 'GET': return self._audit_logs(db)
                raise AppError(404, 'Route not found.')
            if method != 'GET': raise AppError(405, 'Method not allowed.')
            return self._static(route)
        except AppError as exc:
            try: self._json(exc.status, {'error': exc.message})
            except (BrokenPipeError, ConnectionResetError): pass
        except Exception as exc:
            print(f'[error] {method} {self.path}: {type(exc).__name__}: {exc}')
            try: self._json(500, {'error': 'An unexpected server error occurred.'})
            except (BrokenPipeError, ConnectionResetError): pass
        finally:
            db.close()

    # ------------------------------------------------------------------ auth
    def _public_user(self, record):
        return {'id': record['id'], 'name': record['name'], 'username': record['username'],
                'email': record['email'], 'role': record['role']}

    def _unique_username(self, db, seed):
        base = re.sub(r'[^A-Za-z0-9_.-]', '', seed)[:24] or 'user'
        if len(base) < 3: base = (base + 'user')[:6]
        candidate, n = base, 1
        while db.execute('SELECT 1 FROM users WHERE lower(username)=lower(?)', (candidate,)).fetchone():
            n += 1; candidate = f'{base}{n}'
        return candidate

    def _signup(self, db):
        data = self._json_body()
        name = data.get('name', '').strip() if isinstance(data.get('name'), str) else ''
        email = data.get('email', '').strip().lower() if isinstance(data.get('email'), str) else ''
        username = data.get('username', '').strip() if isinstance(data.get('username'), str) else ''
        password = data.get('password', '') if isinstance(data.get('password'), str) else ''
        if not 2 <= len(name) <= 80: raise AppError(400, 'Name must be between 2 and 80 characters.')
        if len(email) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email): raise AppError(400, 'Enter a valid email address.')
        if username and not USERNAME_RE.fullmatch(username): raise AppError(400, 'Username must be 3–30 characters: letters, numbers, dot, dash or underscore.')
        if not 8 <= len(password) <= 128 or not re.search('[A-Za-z]', password) or not re.search('[0-9]', password): raise AppError(400, 'Password must be 8–128 characters and include a letter and a number.')
        if db.execute('SELECT 1 FROM users WHERE lower(email)=?', (email,)).fetchone(): raise AppError(409, 'An account with this email already exists.')
        if username and db.execute('SELECT 1 FROM users WHERE lower(username)=lower(?)', (username,)).fetchone(): raise AppError(409, 'That username is already taken.')
        if not username: username = self._unique_username(db, email.split('@')[0])
        try:
            cursor = db.execute('INSERT INTO users(name,username,email,password_hash) VALUES(?,?,?,?)', (name, username, email, password_hash(password)))
            user_id = cursor.lastrowid
            audit(db, user_id, 'auth.signup', 'user', user_id, details={'email': email})
            db.commit()
        except sqlite3.IntegrityError: raise AppError(409, 'An account with this email or username already exists.')
        user = {'id': user_id, 'name': name, 'username': username, 'email': email, 'role': 'user'}
        return self._json(201, {'user': user}, self._cookie(create_token(user_id, 'user')))

    def _signin(self, db):
        data = self._json_body()
        raw = data.get('identifier', data.get('email'))
        identifier = raw.strip().lower() if isinstance(raw, str) else ''
        password = data.get('password', '') if isinstance(data.get('password'), str) else ''
        if not identifier or not password: raise AppError(400, 'Enter your username or email and your password.')
        record = db.execute('SELECT * FROM users WHERE lower(email)=? OR lower(username)=?', (identifier, identifier)).fetchone()
        valid = bool(record and password_matches(password, record['password_hash']))
        if not valid:
            audit(db, record['id'] if record else None, 'auth.signin', 'user', record['id'] if record else None, 'denied', {'identifier': identifier[:80]})
            db.commit()
            raise AppError(401, 'Invalid username/email or password.')
        audit(db, record['id'], 'auth.signin', 'user', record['id'])
        db.commit()
        return self._json(200, {'user': self._public_user(record)}, self._cookie(create_token(record['id'], record['role'])))

    def _logout(self, db):
        try:
            user = self._user(db)
            audit(db, user['id'], 'auth.logout', 'user', user['id']); db.commit()
        except AppError: pass
        return self._json(204, {}, self._cookie())

    def _me(self, db):
        return self._json(200, {'user': self._user(db)})

    def _list_users(self, db):
        """Registered users other than the caller, for the 'grant access' picker."""
        user = self._user(db)
        rows = db.execute('SELECT id,name,username,email FROM users WHERE id<>? ORDER BY lower(name)', (user['id'],)).fetchall()
        return self._json(200, {'users': [dict(r) for r in rows]})

    # ------------------------------------------------------- access control
    def _access(self, db, user, doc):
        """Return the caller's rights on a document row (or all-False)."""
        rights = {'level': None, 'can_read': False, 'can_edit': False, 'can_delete': False, 'can_share': False}
        if doc['owner_id'] == user['id']:
            return {'level': 'owner', 'can_read': True, 'can_edit': True, 'can_delete': True, 'can_share': True}
        grant = db.execute('SELECT can_read,can_edit FROM document_permissions WHERE document_id=? AND user_id=?', (doc['id'], user['id'])).fetchone()
        if grant and (grant['can_read'] or grant['can_edit']):
            rights.update(level='edit' if grant['can_edit'] else 'read', can_read=True, can_edit=bool(grant['can_edit']))
        if user['role'] == 'admin':
            rights.update(can_read=True, can_delete=True)
            rights['level'] = rights['level'] or 'admin'
        return rights

    def _load_document(self, db, user, doc_id, action, need):
        """Fetch a document and enforce `need` ('can_read','can_edit','can_delete','can_share'); audit denials."""
        doc = db.execute('SELECT * FROM documents WHERE id=?', (doc_id,)).fetchone()
        if not doc:
            audit(db, user['id'], action, 'document', doc_id, 'denied', {'reason': 'not_found'}); db.commit()
            raise AppError(404, 'Document not found.')
        rights = self._access(db, user, doc)
        if not rights[need]:
            audit(db, user['id'], action, 'document', doc_id, 'denied', {'reason': 'no_permission', 'needed': need, 'title': doc['title']}); db.commit()
            raise AppError(403, 'You do not have permission to do this with this document.')
        return doc, rights

    def _doc_payload(self, doc, rights, owner):
        return {'id': doc['id'], 'title': doc['title'] or doc['original_name'], 'description': doc['description'],
                'category': doc['category'], 'original_name': doc['original_name'], 'mime_type': doc['mime_type'],
                'size_bytes': doc['size_bytes'], 'created_at': doc['created_at'], 'owner_id': doc['owner_id'],
                'owner_name': owner['name'], 'owner_username': owner['username'],
                'access': rights['level'], 'can_edit': rights['can_edit'], 'can_delete': rights['can_delete'],
                'can_share': rights['can_share']}

    # ------------------------------------------------------------- documents
    @staticmethod
    def _like(text):
        return '%' + text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'

    def _list_documents(self, db):
        user = self._user(db)
        q = self.query
        scope = q.get('scope', 'all')
        where = ['(d.owner_id=:me OR p.can_read=1)']
        params = {'me': user['id']}
        if scope == 'mine': where.append('d.owner_id=:me')
        elif scope == 'shared': where.append('d.owner_id<>:me')
        elif scope != 'all': raise AppError(400, 'Unknown scope.')
        text = q.get('q', '').strip()[:120]
        if text:
            where.append("(d.title LIKE :q ESCAPE '\\' OR d.original_name LIKE :q ESCAPE '\\')"); params['q'] = self._like(text)
        category = q.get('category', '').strip()
        if category:
            if category not in CATEGORIES: raise AppError(400, 'Unknown category.')
            where.append('d.category=:category'); params['category'] = category
        owner = q.get('owner', '').strip()[:80]
        if owner:
            where.append("(u.username LIKE :owner ESCAPE '\\' OR u.name LIKE :owner ESCAPE '\\' OR u.email LIKE :owner ESCAPE '\\')"); params['owner'] = self._like(owner)
        day = q.get('date', '').strip()
        if day:
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day): raise AppError(400, 'Date must look like YYYY-MM-DD.')
            try: offset = int(q.get('tz', '0'))
            except ValueError: raise AppError(400, 'Invalid time zone offset.')
            if not -840 <= offset <= 840: raise AppError(400, 'Invalid time zone offset.')
            where.append("date(d.created_at, :tz) = :day"); params['tz'] = f'{offset:+d} minutes'; params['day'] = day
        rows = db.execute(f'''SELECT d.*, u.name AS owner_name, u.username AS owner_username, p.can_edit AS grant_edit
            FROM documents d JOIN users u ON u.id=d.owner_id
            LEFT JOIN document_permissions p ON p.document_id=d.id AND p.user_id=:me
            WHERE {' AND '.join(where)} ORDER BY d.id DESC LIMIT 500''', params).fetchall()
        docs = []
        for row in rows:
            mine = row['owner_id'] == user['id']
            rights = {'level': 'owner' if mine else ('edit' if row['grant_edit'] else 'read'),
                      'can_edit': mine or bool(row['grant_edit']), 'can_delete': mine, 'can_share': mine}
            docs.append(self._doc_payload(row, rights, {'name': row['owner_name'], 'username': row['owner_username']}))
        return self._json(200, {'documents': docs})

    def _categories(self, db):
        user = self._user(db)
        rows = db.execute('''SELECT d.category AS category, COUNT(*) AS n, COALESCE(SUM(d.size_bytes),0) AS bytes
            FROM documents d LEFT JOIN document_permissions p ON p.document_id=d.id AND p.user_id=?
            WHERE d.owner_id=? OR p.can_read=1 GROUP BY d.category''', (user['id'], user['id'])).fetchall()
        counts = {r['category']: (r['n'], r['bytes']) for r in rows}
        return self._json(200, {'categories': [{'name': c, 'count': counts.get(c, (0, 0))[0], 'size_bytes': counts.get(c, (0, 0))[1]} for c in CATEGORIES]})

    def _get_document(self, db, doc_id):
        user = self._user(db)
        doc, rights = self._load_document(db, user, doc_id, 'document.view', 'can_read')
        owner = db.execute('SELECT name,username FROM users WHERE id=?', (doc['owner_id'],)).fetchone()
        payload = self._doc_payload(doc, rights, owner)
        payload['permissions'] = []
        if rights['can_share']:
            grants = db.execute('''SELECT p.user_id,p.can_read,p.can_edit,p.created_at,u.name,u.username,u.email
                FROM document_permissions p JOIN users u ON u.id=p.user_id WHERE p.document_id=? ORDER BY lower(u.name)''', (doc_id,)).fetchall()
            payload['permissions'] = [{**dict(g), 'can_read': bool(g['can_read']), 'can_edit': bool(g['can_edit'])} for g in grants]
        return self._json(200, {'document': payload})

    def _clean_meta(self, data, require_title):
        title = data.get('title', '').strip() if isinstance(data.get('title'), str) else None
        description = data.get('description', '').strip() if isinstance(data.get('description'), str) else None
        category = data.get('category', '').strip() if isinstance(data.get('category'), str) else None
        if title is not None and not (1 <= len(title) <= 120): raise AppError(400, 'Title must be between 1 and 120 characters.')
        if require_title and title is None: raise AppError(400, 'Enter a document title.')
        if description is not None and len(description) > 1000: raise AppError(400, 'Description must be 1000 characters or fewer.')
        if category is not None and category not in CATEGORIES: raise AppError(400, 'Choose a valid category.')
        return title, description, category

    def _update_document(self, db, doc_id):
        user = self._user(db)
        doc, _ = self._load_document(db, user, doc_id, 'document.update', 'can_edit')
        title, description, category = self._clean_meta(self._json_body(), require_title=False)
        db.execute('UPDATE documents SET title=?, description=?, category=? WHERE id=?',
                   (doc['title'] if title is None else title, doc['description'] if description is None else description,
                    doc['category'] if category is None else category, doc_id))
        audit(db, user['id'], 'document.update', 'document', doc_id, details={'title': title or doc['title']})
        db.commit()
        return self._get_document(db, doc_id)

    def _parse_multipart(self, body, content_type):
        """Return (fields, file) where file is (filename, bytes) or None."""
        match = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', content_type)
        if not match: raise AppError(400, 'Invalid upload form.')
        delimiter = b'--' + (match.group(1) or match.group(2)).strip().encode()
        fields, upload = {}, None
        for part in body.split(delimiter)[1:]:
            if part.startswith(b'--'): break
            if part.startswith(b'\r\n'): part = part[2:]
            if part.endswith(b'\r\n'): part = part[:-2]
            header_bytes, sep, data = part.partition(b'\r\n\r\n')
            if not sep: continue
            try: headers = header_bytes.decode('utf-8')
            except UnicodeDecodeError: headers = header_bytes.decode('latin-1')
            name = re.search(r'(?:^|[;\s])name="([^"]*)"', headers)
            if not name: continue
            filename = re.search(r'filename="([^"]*)"', headers)
            if filename is not None:
                if name.group(1) == 'file' and upload is None: upload = (filename.group(1), data)
            else:
                fields[name.group(1)] = data.decode('utf-8', errors='replace')
        return fields, upload

    def _upload_document(self, db):
        user = self._user(db)
        content_type = self.headers.get('Content-Type', '')
        if 'multipart/form-data' not in content_type: raise AppError(415, 'Upload must use multipart form data.')
        body = self._body(MAX_UPLOAD + 256 * 1024)
        fields, upload = self._parse_multipart(body, content_type)
        if not upload or not upload[0]: raise AppError(400, 'Choose a file to upload.')
        filename, content = upload
        if len(content) > MAX_UPLOAD: raise AppError(413, f'File exceeds the {MAX_UPLOAD // (1024 * 1024)} MB upload limit.')
        if not content: raise AppError(400, 'The selected file is empty.')
        clean_name = re.sub(r'[\x00-\x1f\x7f]', '', Path(filename.replace('\\', '/')).name).strip()[:180]
        if not clean_name or clean_name in {'.', '..'}: raise AppError(400, 'Invalid file name.')
        mime = EXT_TO_MIME.get(Path(clean_name).suffix.lower())
        if mime not in ALLOWED_TYPES: raise AppError(400, 'Unsupported file type. Upload a PDF, TXT, PNG, or JPEG file.')
        signatures = {
            'application/pdf': lambda b: b.startswith(b'%PDF-'),
            'image/png': lambda b: b.startswith(b'\x89PNG\r\n\x1a\n'),
            'image/jpeg': lambda b: b.startswith(b'\xff\xd8\xff'),
            'text/plain': lambda b: b'\x00' not in b,
        }
        if not signatures[mime](content): raise AppError(400, 'File content does not match its file extension.')
        meta = {'title': fields.get('title') or Path(clean_name).stem[:120] or clean_name,
                'description': fields.get('description', ''), 'category': fields.get('category') or 'General'}
        title, description, category = self._clean_meta(meta, require_title=True)
        stored = secrets.token_hex(20) + '.upload'
        target = UPLOAD_DIR / stored
        try:
            target.write_bytes(content)
            cursor = db.execute('''INSERT INTO documents(owner_id,original_name,stored_name,mime_type,size_bytes,title,description,category)
                                   VALUES(?,?,?,?,?,?,?,?)''', (user['id'], clean_name, stored, mime, len(content), title, description or '', category))
            doc_id = cursor.lastrowid
            audit(db, user['id'], 'document.upload', 'document', doc_id, details={'title': title, 'originalName': clean_name, 'sizeBytes': len(content), 'category': category})
            db.commit()
        except Exception:
            db.rollback()
            target.unlink(missing_ok=True)
            raise
        return self._json(201, {'document': {'id': doc_id, 'title': title, 'original_name': clean_name, 'mime_type': mime,
                                             'size_bytes': len(content), 'category': category, 'description': description or ''}})

    def _download_document(self, db, doc_id):
        user = self._user(db)
        doc, _ = self._load_document(db, user, doc_id, 'document.download', 'can_read')
        file_path = UPLOAD_DIR / doc['stored_name']
        if not file_path.is_file(): raise AppError(404, 'Stored document is missing.')
        data = file_path.read_bytes()
        audit(db, user['id'], 'document.download', 'document', doc_id, details={'title': doc['title']}); db.commit()
        safe_name = re.sub(r'[\r\n"\\]', '_', doc['original_name'])
        self._headers(200, doc['mime_type'], {'Content-Length': str(len(data)), 'Content-Disposition': f'attachment; filename="{safe_name}"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})
        self.wfile.write(data)

    def _delete_document(self, db, doc_id):
        user = self._user(db)
        doc, _ = self._load_document(db, user, doc_id, 'document.delete', 'can_delete')
        try:
            db.execute('DELETE FROM documents WHERE id=?', (doc_id,))
            audit(db, user['id'], 'document.delete', 'document', doc_id, details={'title': doc['title']})
            db.commit()
        except Exception: db.rollback(); raise
        (UPLOAD_DIR / doc['stored_name']).unlink(missing_ok=True)
        return self._json(204, {})

    # ----------------------------------------------------------- permissions
    def _grant_permission(self, db, doc_id):
        user = self._user(db)
        doc, _ = self._load_document(db, user, doc_id, 'permission.grant', 'can_share')
        data = self._json_body()
        target_id = data.get('user_id')
        if not isinstance(target_id, int) or isinstance(target_id, bool): raise AppError(400, 'Choose a user to share with.')
        can_edit = data.get('can_edit') is True
        can_read = data.get('can_read') is True or can_edit  # edit access always includes read
        if not can_read: raise AppError(400, 'Select at least one permission.')
        target = db.execute('SELECT id,name FROM users WHERE id=?', (target_id,)).fetchone()
        if not target: raise AppError(404, 'That user does not exist.')
        if target_id == doc['owner_id']: raise AppError(400, 'The owner already has full access.')
        existed = db.execute('SELECT 1 FROM document_permissions WHERE document_id=? AND user_id=?', (doc_id, target_id)).fetchone()
        db.execute('''INSERT INTO document_permissions(document_id,user_id,can_read,can_edit,granted_by) VALUES(?,?,?,?,?)
                      ON CONFLICT(document_id,user_id) DO UPDATE SET can_read=excluded.can_read, can_edit=excluded.can_edit, granted_by=excluded.granted_by''',
                   (doc_id, target_id, 1, int(can_edit), user['id']))
        audit(db, user['id'], 'permission.update' if existed else 'permission.grant', 'document', doc_id,
              details={'title': doc['title'], 'target': target['name'], 'canEdit': can_edit})
        db.commit()
        return self._get_document(db, doc_id)

    def _revoke_permission(self, db, doc_id, target_id):
        user = self._user(db)
        doc, _ = self._load_document(db, user, doc_id, 'permission.revoke', 'can_share')
        target = db.execute('SELECT name FROM users WHERE id=?', (target_id,)).fetchone()
        cursor = db.execute('DELETE FROM document_permissions WHERE document_id=? AND user_id=?', (doc_id, target_id))
        if not cursor.rowcount: raise AppError(404, 'That user does not have access.')
        audit(db, user['id'], 'permission.revoke', 'document', doc_id, details={'title': doc['title'], 'target': target['name'] if target else ''})
        db.commit()
        return self._json(204, {})

    # ---------------------------------------------------------- activity log
    def _audit_logs(self, db):
        user = self._user(db)
        try: limit = max(1, min(200, int(self.query.get('limit', '200'))))
        except ValueError: raise AppError(400, 'Invalid limit.')
        base = '''SELECT l.id,l.actor_id,u.name AS actor_name,l.action,l.resource_type,l.resource_id,l.outcome,l.details_json,l.created_at
                  FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id'''
        if user['role'] == 'admin':
            scope = 'all'
            rows = db.execute(base + ' ORDER BY l.id DESC LIMIT ?', (limit,)).fetchall()
        else:  # members see their own actions plus activity on documents they own
            scope = 'mine'
            rows = db.execute(base + ''' WHERE l.actor_id=:me OR (l.resource_type='document' AND l.resource_id IN
                     (SELECT CAST(id AS TEXT) FROM documents WHERE owner_id=:me)) ORDER BY l.id DESC LIMIT :limit''',
                              {'me': user['id'], 'limit': limit}).fetchall()
        return self._json(200, {'scope': scope, 'logs': [{**dict(row), 'details': json.loads(row['details_json'])} for row in rows]})

    def _static(self, route):
        if route == '/': route = '/index.html'
        relative = unquote(route).lstrip('/')
        candidate = (PUBLIC / relative).resolve()
        if PUBLIC.resolve() not in candidate.parents and candidate != PUBLIC.resolve(): raise AppError(403, 'Forbidden.')
        if not candidate.is_file(): raise AppError(404, 'Page not found.')
        mime = mimetypes.guess_type(candidate.name)[0] or 'application/octet-stream'
        data = candidate.read_bytes()
        self._headers(200, mime + ('; charset=utf-8' if mime.startswith(('text/', 'application/javascript')) else ''), {'Content-Length': str(len(data))})
        self.wfile.write(data)


def main():
    if PRODUCTION and (len(SECRET) < 32 or SECRET == b'local-development-secret-change-before-deployment'):
        raise RuntimeError('Set APP_SECRET to a random secret of at least 32 bytes in production.')
    connect_db().close()
    server = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print(f'[server] TrustVault is running at http://localhost:{PORT}')
    print(f'[database] SQLite: {DB_PATH}')
    print(f'[uploads] Private directory: {UPLOAD_DIR}')
    try: server.serve_forever()
    except KeyboardInterrupt: print('\n[server] Shutdown requested.')
    finally: server.server_close()

if __name__ == '__main__': main()
