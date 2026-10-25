/* TrustVault front end — hash-routed single page app (no build step, CSP-safe: no inline handlers or styles). */
const root = document.getElementById('app');
const MAX_BYTES = 5 * 1024 * 1024;
const FILE_ACCEPT = '.pdf,.txt,.png,.jpg,.jpeg,application/pdf,text/plain,image/png,image/jpeg';
const state = { user: null, flash: null, collapsed: false, docScope: 'all', docQuery: '', filters: { q: '', category: '', owner: '', date: '' } };
let renderSeq = 0;
try { state.collapsed = localStorage.getItem('tv.collapsed') === '1'; } catch { /* storage unavailable */ }

/* ---------- utilities ---------- */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const go = (path) => { location.hash = path; };
const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, params: new URLSearchParams(qs || '') };
}
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  if (response.status === 204) return null;
  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    const err = new Error((data && data.error) || 'Something went wrong. Please try again.');
    err.status = response.status; throw err;
  }
  return data;
}
const jsonOpts = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const fmtBytes = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const initial = (u) => esc(((u && (u.name || u.username)) || '?').trim().charAt(0).toUpperCase());
const kindOf = (doc) => doc.mime_type === 'application/pdf' ? 'PDF' : doc.mime_type.startsWith('image/') ? 'IMG' : 'TXT';
const ownerLabel = (d, me) => d.owner_id === me.id ? 'You' : (d.owner_username || d.owner_name);

const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/>',
  docs: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  shield: '<path d="M12 3 4 6v5c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6z"/><path d="m9 12 2 2 4-4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.5 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  logout: '<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4"/><path d="m16 8 4 4-4 4"/><path d="M20 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .7 3.5 2.6 3.5 5.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  download: '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/>',
};
const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const brand = (href) => `<a class="brand" href="${href}" aria-label="TrustVault"><span class="brand-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z"/></svg></span><span class="brand-text">TrustVault</span></a>`;

function notify(message, type = 'error') {
  const box = $('#flash'); if (!box) return;
  box.innerHTML = message ? `<p class="alert ${type === 'ok' ? 'ok' : ''}" role="${type === 'ok' ? 'status' : 'alert'}">${esc(message)}</p>` : '';
  if (message) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function showFlash() { if (state.flash) { notify(state.flash.text, state.flash.type); state.flash = null; } }
function setFlash(text, type = 'ok') { state.flash = { text, type }; }

/* ---------- public pages ---------- */
function publicFrame(inner) {
  const nav = state.user
    ? `<a class="btn btn-primary btn-sm" href="#/dashboard">Open workspace</a>`
    : `<a href="#/about" class="keep">About</a><a href="#/signin" class="keep">Sign in</a><a class="btn btn-primary btn-sm" href="#/signup">Get started</a>`;
  return `<div class="page-public"><header class="public-header">${brand('#/')}<nav class="public-nav" aria-label="Main">${nav}</nav></header><main>${inner}</main><footer class="public-footer"><span>© 2026 TrustVault</span><span>Secure sharing. Clear accountability.</span></footer></div>`;
}
function homePage() {
  return publicFrame(`<section class="hero"><h1>Your documents. <em>Under control.</em></h1><p class="lead">Store important files, sort them into categories, and share them with exactly the people you choose — with a clear record of everything that happens.</p><div class="hero-actions"><a class="btn btn-primary" href="#/signup">Create your vault</a><a class="btn btn-ghost" href="#/about">Explore TrustVault</a></div></section>
  <section class="feature-grid" aria-label="Features">
    <article class="feature">${icon('lock')}<h2>Private by default</h2><p>Every file belongs to its owner. The server checks access on each request, not just in the interface.</p></article>
    <article class="feature">${icon('users')}<h2>Share with precision</h2><p>Give a registered user read access or edit access, and take it back whenever you need to.</p></article>
    <article class="feature">${icon('clock')}<h2>Every action recorded</h2><p>Uploads, downloads, sharing changes and blocked attempts all appear in your activity log.</p></article>
  </section>`);
}
function aboutPage() {
  return publicFrame(`<section class="about"><h1>Technology should feel simple.</h1><p class="lead">TrustVault is a secure document workspace built around clear permissions, privacy, and accountability. The interface stays quiet so your work can take the lead.</p>
  <div class="about-points"><div><strong>Clarity</strong><p>Six places, each with one job: dashboard, documents, search, categories, upload and activity.</p></div><div><strong>Privacy</strong><p>Protected operations are verified by the server, and files are never served as public static content.</p></div><div><strong>Accountability</strong><p>Important actions are written to an audit trail you can review at any time.</p></div></div>
  <a class="btn btn-primary" href="#/signup">Get started</a></section>`);
}

const SHIELD = `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 6 12 13v16c0 14 8.5 23.5 20 29z" fill="#e5e5e5"/><path d="M32 6l20 7v16c0 14-8.5 23.5-20 29z" fill="#8a8a8a"/><path d="M32 6 12 13v16c0 14 8.5 23.5 20 29 11.5-5.5 20-15 20-29V13z" fill="none" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
function field(id, label, type, placeholder, ic, auto, extra = '') {
  const toggle = type === 'password' ? `<button class="toggle-vis" type="button" data-toggle="${id}" aria-label="Show password">${icon('eye')}</button>` : '';
  return `<div class="field"><label for="${id}">${label}</label><div class="control">${icon(ic)}<input class="input ${toggle ? 'has-toggle' : ''}" id="${id}" name="${id}" type="${type}" placeholder="${placeholder}" autocomplete="${auto}" ${extra}>${toggle}</div></div>`;
}
function authPage(signup) {
  const form = signup
    ? `<div class="two-col">${field('name', 'Full name', 'text', 'Your full name', 'user', 'name', 'required minlength="2"')}${field('username', 'Username', 'text', 'Choose a username', 'user', 'username', 'minlength="3" maxlength="30"')}</div>
       ${field('email', 'Email address', 'email', 'you@example.com', 'mail', 'email', 'required')}
       <div class="two-col">${field('password', 'Password', 'password', 'At least 8 characters', 'lock', 'new-password', 'required minlength="8"')}${field('confirm', 'Confirm password', 'password', 'Repeat password', 'lock', 'new-password', 'required')}</div>`
    : `${field('identifier', 'Username or email', 'text', 'Enter your username or email', 'user', 'username', 'required autofocus')}
       ${field('password', 'Password', 'password', 'Enter your password', 'lock', 'current-password', 'required')}`;
  return `<div class="auth-page"><div class="auth-top">${brand('#/')}</div><div class="auth-wrap"><section class="auth-card">
    <div class="auth-aside"><div class="shield-tile">${SHIELD}</div><h2>Your documents, <span>our priority.</span></h2><p>Secure, organized, and always within your control. Keep your important documents protected in one place.</p>
      <div class="chips"><span class="chip">${icon('check')}Private</span><span class="chip">${icon('key')}Permissioned</span><span class="chip">${icon('clock')}Audited</span></div></div>
    <div class="auth-main"><span class="pill">Secure access</span><h1>${signup ? 'Create account' : 'Welcome back'}</h1><p class="sub">${signup ? 'Set up your private document vault.' : 'Sign in to access your secure document vault.'}</p>
      <form id="auth-form" novalidate>${form}<p id="form-error" class="alert" role="alert" hidden></p><button class="btn btn-primary btn-block" type="submit">${signup ? 'Create account' : 'Sign in'}</button></form>
      <p class="auth-switch">${signup ? 'Already have an account?' : 'Don’t have an account?'} <a href="#/${signup ? 'signin' : 'signup'}">${signup ? 'Sign in' : 'Create account'}</a></p><a class="back-home" href="#/">← Back to home</a></div>
  </section></div></div>`;
}
function bindAuth(signup) {
  $$('[data-toggle]').forEach((btn) => btn.addEventListener('click', () => {
    const input = $('#' + btn.dataset.toggle); const show = input.type === 'password';
    input.type = show ? 'text' : 'password'; btn.innerHTML = icon(show ? 'eyeoff' : 'eye'); btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  }));
  const form = $('#auth-form'); const errorBox = $('#form-error');
  const fail = (m) => { errorBox.textContent = m; errorBox.hidden = false; };
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); errorBox.hidden = true;
    const v = (n) => form.elements.namedItem(n)?.value ?? '';
    let payload;
    if (signup) {
      payload = { name: v('name').trim(), username: v('username').trim(), email: v('email').trim(), password: v('password') };
      if (payload.name.length < 2) return fail('Name must contain at least 2 characters.');
      if (payload.username && !/^[A-Za-z0-9_.-]{3,30}$/.test(payload.username)) return fail('Username: 3–30 letters, numbers, dot, dash or underscore.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return fail('Enter a valid email address.');
      if (!/(?=.*[A-Za-z])(?=.*\d).{8,128}/.test(payload.password)) return fail('Use at least 8 characters, including a letter and a number.');
      if (payload.password !== v('confirm')) return fail('Your passwords do not match.');
    } else {
      payload = { identifier: v('identifier').trim(), password: v('password') };
      if (!payload.identifier || !payload.password) return fail('Enter your username or email and your password.');
    }
    const button = form.querySelector('button[type="submit"]'); const label = button.textContent;
    button.disabled = true; button.textContent = 'Please wait…';
    try {
      state.user = (await api(`/api/auth/${signup ? 'signup' : 'signin'}`, jsonOpts('POST', payload))).user;
      go('/dashboard');
    } catch (err) { fail(err.message); button.disabled = false; button.textContent = label; }
  });
}

/* ---------- app shell ---------- */
const NAV = [['dashboard', 'Dashboard', 'home'], ['documents', 'My Documents', 'docs'], ['search', 'Search Documents', 'search'], ['categories', 'Categories', 'grid'], ['upload', 'Upload Document', 'upload'], ['activity', 'Activity Logs', 'clock']];
function shell(active, inner) {
  const u = state.user;
  const links = NAV.map(([key, label, ic]) => `<a href="#/${key}" class="${key === active ? 'active' : ''}" ${key === active ? 'aria-current="page"' : ''} title="${label}">${icon(ic)}<span>${label}</span></a>`).join('');
  return `<div class="shell ${state.collapsed ? 'collapsed' : ''}" id="shell">
    <aside class="sidebar" id="sidebar" aria-label="Sidebar"><div class="side-head">${brand('#/dashboard')}<button class="icon-btn side-toggle" id="side-toggle" type="button" aria-label="Collapse sidebar">${icon('menu')}</button></div>
      <nav class="nav" aria-label="Workspace">${links}</nav>
      <div class="side-foot"><div class="vault-note">${icon('shield')}<div><strong>Vault protected</strong><span>Your files stay secure</span></div></div><button class="signout" id="logout" type="button" title="Sign out">${icon('logout')}<span>Sign out</span></button></div></aside>
    <div class="scrim" id="scrim"></div>
    <div class="main-col"><header class="topbar"><div class="topbar-left"><button class="icon-btn menu-btn" id="menu-btn" type="button" aria-label="Open menu">${icon('menu')}</button></div>
      <div class="topbar-right"><span class="session-pill">Secure session</span><div class="who"><strong>${esc(u.name)}</strong><span>${u.role === 'admin' ? 'Administrator' : esc(u.username ? '@' + u.username : u.email)}</span></div><div class="avatar" aria-hidden="true">${initial(u)}</div></div></header>
      <main class="content" id="content"><div id="flash" aria-live="polite"></div>${inner}</main></div></div>`;
}
function bindShell() {
  const sh = $('#shell');
  $('#side-toggle').addEventListener('click', () => {
    state.collapsed = !state.collapsed; sh.classList.toggle('collapsed', state.collapsed);
    try { localStorage.setItem('tv.collapsed', state.collapsed ? '1' : '0'); } catch { /* ignore */ }
  });
  $('#menu-btn').addEventListener('click', () => sh.classList.toggle('nav-open'));
  // Clicking the page you're already on re-fetches it (the hash doesn't change, so no hashchange fires).
  $$('.nav a').forEach((link) => link.addEventListener('click', (e) => { if (link.classList.contains('active')) { e.preventDefault(); sh.classList.remove('nav-open'); render(); } }));
  $('#scrim').addEventListener('click', () => sh.classList.remove('nav-open'));
  $('#logout').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* already signed out */ } state.user = null; go('/'); });
}

/* ---------- document list pieces ---------- */
function docRow(d) {
  const me = state.user; const owned = d.access === 'owner';
  const badge = owned ? '' : `<span class="tag solid">${d.access === 'edit' ? 'Can edit' : 'Read only'}</span>`;
  return `<article class="doc"><div class="file-mark">${kindOf(d)}</div>
    <div class="doc-main"><a class="doc-title" href="#/documents/${d.id}">${esc(d.title)}</a><div class="doc-meta"><span class="tag">${esc(d.category)}</span><span>${esc(d.original_name)}</span><span>${fmtBytes(d.size_bytes)}</span><span>${fmtDate(d.created_at)}</span><span>Owner: ${esc(ownerLabel(d, me))}</span>${badge}</div></div>
    <div class="doc-actions"><a class="btn btn-ghost btn-sm" href="#/documents/${d.id}">${d.can_share ? 'Manage' : 'Open'}</a><button class="btn btn-ghost btn-sm" type="button" data-action="download" data-id="${d.id}" data-name="${esc(d.original_name)}">Download</button>${d.can_delete ? `<button class="btn btn-danger btn-sm" type="button" data-action="delete" data-id="${d.id}" data-name="${esc(d.title)}">Delete</button>` : ''}</div></article>`;
}
function docList(docs, empty) {
  if (docs.length) return `<div class="doc-list">${docs.map(docRow).join('')}</div>`;
  return `<div class="empty">${icon('docs')}<h3>${esc(empty.title)}</h3><p>${esc(empty.text)}</p>${empty.cta === false ? '' : '<a class="btn btn-primary" href="#/upload">Upload your first document</a>'}</div>`;
}
async function downloadDoc(id, name) {
  const response = await fetch(`/api/documents/${id}/download`, { credentials: 'same-origin' });
  if (!response.ok) { let m = 'Download failed.'; try { m = (await response.json()).error || m; } catch { /* not json */ } throw new Error(m); }
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function bindDocActions(scope, refresh) {
  scope.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action]'); if (!btn) return;
    const { action, id, name } = btn.dataset; btn.disabled = true;
    try {
      if (action === 'download') await downloadDoc(id, name);
      if (action === 'delete') {
        if (!window.confirm(`Delete “${name}”? This cannot be undone.`)) { btn.disabled = false; return; }
        await api(`/api/documents/${id}`, { method: 'DELETE' }); notify('Document deleted.', 'ok'); await refresh();
      }
    } catch (err) { notify(err.message); }
    finally { btn.disabled = false; }
  });
}

/* ---------- pages (each returns { html, bind }) ---------- */
async function dashboardPage() {
  const [docsRes, logsRes] = await Promise.all([api('/api/documents'), api('/api/audit-logs?limit=6')]);
  const docs = docsRes.documents; const me = state.user;
  const mine = docs.filter((d) => d.access === 'owner'); const shared = docs.length - mine.length;
  const bytes = mine.reduce((s, d) => s + d.size_bytes, 0); const cats = new Set(docs.map((d) => d.category)).size;
  const stat = (ic, label, value, note) => `<div class="stat"><div class="label">${icon(ic)}${label}</div><strong>${value}</strong><small>${note}</small></div>`;
  const html = shell('dashboard', `<div class="page-head"><div><h1>Welcome back, ${esc(me.name.split(' ')[0])}</h1><p>Here’s what’s happening in your vault.</p></div><a class="btn btn-primary" href="#/upload">${icon('plus')}Upload document</a></div>
    <section class="stats" aria-label="Summary">${stat('docs', 'My documents', mine.length, 'Files you own')}${stat('users', 'Shared with me', shared, 'Files others shared with you')}${stat('grid', 'Categories in use', cats, 'Across all your files')}${stat('shield', 'Storage used', fmtBytes(bytes), 'Files you own')}</section>
    <div class="two-up"><section class="card"><div class="card-head"><div><h2>Recent documents</h2><p>Your latest files and shared items</p></div><a class="btn btn-ghost btn-sm" href="#/documents">View all</a></div>${docList(docs.slice(0, 5), { title: 'No documents yet', text: 'Upload a PDF, text file, or image to get started.' })}</section>
    <section class="card"><div class="card-head"><div><h2>Recent activity</h2><p>${logsRes.scope === 'all' ? 'Across the whole vault' : 'Your latest actions'}</p></div><a class="btn btn-ghost btn-sm" href="#/activity">View all</a></div>${logList(logsRes.logs, 'No activity yet.')}</section></div>`);
  return { html, bind: () => bindDocActions($('#content'), () => render()) };
}

async function documentsPage(params) {
  const category = params.get('category') || '';
  const cats = (await api('/api/categories')).categories;
  const scopes = [['all', 'All'], ['mine', 'Owned by me'], ['shared', 'Shared with me']];
  const html = shell('documents', `<div class="page-head"><div><h1>My Documents</h1><p>View, organize and manage your secure documents.</p></div><a class="btn btn-primary" href="#/upload">${icon('plus')}Upload document</a></div>
    <div class="tabs" role="tablist">${scopes.map(([k, l]) => `<button class="tab ${state.docScope === k ? 'active' : ''}" type="button" role="tab" data-scope="${k}">${l}</button>`).join('')}</div>
    <form class="searchbar" id="doc-search" role="search"><div class="control">${icon('search')}<input class="input" id="doc-q" type="search" placeholder="Search documents by title…" value="${esc(state.docQuery)}" aria-label="Search documents by title"></div>
      <div class="select-wrap"><select class="select" id="doc-cat" aria-label="Filter by category"><option value="">All categories</option>${cats.map((c) => `<option ${c.name === category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div><button class="btn btn-primary" type="submit">Search</button></form>
    <section class="card"><div class="card-head"><div><h2>${category ? esc(category) : 'All documents'}</h2><p>Your uploaded files in one place</p></div><span class="count-pill" id="doc-count">…</span></div><div id="doc-results"></div></section>`);
  return {
    html, bind() {
      const results = $('#doc-results');
      async function load() {
        const q = new URLSearchParams({ scope: state.docScope }); const text = $('#doc-q').value.trim(); const cat = $('#doc-cat').value;
        state.docQuery = text; if (text) q.set('q', text); if (cat) q.set('category', cat);
        try {
          const { documents } = await api('/api/documents?' + q);
          $('#doc-count').textContent = `${documents.length} document${documents.length === 1 ? '' : 's'}`;
          const filtered = text || cat || state.docScope !== 'all';
          results.innerHTML = docList(documents, filtered ? { title: 'No documents found', text: 'Nothing matches these filters. Try a different search.', cta: false } : { title: 'No documents found', text: 'Your vault is currently empty. Upload your first document to get started.' });
        } catch (err) { notify(err.message); }
      }
      $$('.tab').forEach((t) => t.addEventListener('click', () => { state.docScope = t.dataset.scope; $$('.tab').forEach((x) => x.classList.toggle('active', x === t)); load(); }));
      $('#doc-search').addEventListener('submit', (e) => { e.preventDefault(); load(); });
      $('#doc-cat').addEventListener('change', load);
      bindDocActions(results, load); load();
    },
  };
}

async function searchPage() {
  const cats = (await api('/api/categories')).categories; const f = state.filters;
  const html = shell('search', `<div class="page-head"><div><h1>Search Documents</h1><p>Find documents by name, category, owner, or upload date.</p></div><a class="btn btn-ghost" href="#/documents">${icon('back')}Back to documents</a></div>
    <section class="card"><form id="search-form"><div class="filter-grid">
      <div class="field"><label for="f-q">Document title or filename</label><input class="input" id="f-q" type="text" placeholder="Enter document title or filename" value="${esc(f.q)}"></div>
      <div class="field"><label for="f-cat">Category</label><select class="select" id="f-cat"><option value="">All categories</option>${cats.map((c) => `<option ${c.name === f.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="f-owner">Owner</label><input class="input" id="f-owner" type="text" placeholder="Enter owner’s username or name" value="${esc(f.owner)}"></div>
      <div class="field"><label for="f-date">Upload date</label><input class="input" id="f-date" type="date" value="${esc(f.date)}"><span class="hint">Pick a day to find documents uploaded on it.</span></div></div>
      <div class="filter-actions"><button class="btn btn-primary" type="submit">${icon('search')}Search documents</button><button class="btn btn-ghost" type="button" id="f-reset">Reset filters</button></div></form></section>
    <section class="card"><div class="card-head"><div><h2>Results</h2><p>Documents you own or that were shared with you</p></div><span class="count-pill" id="res-count">…</span></div><div id="results"></div></section>`);
  return {
    html, bind() {
      const results = $('#results');
      async function run() {
        Object.assign(state.filters, { q: $('#f-q').value.trim(), category: $('#f-cat').value, owner: $('#f-owner').value.trim(), date: $('#f-date').value });
        const q = new URLSearchParams(); const s = state.filters;
        if (s.q) q.set('q', s.q); if (s.category) q.set('category', s.category); if (s.owner) q.set('owner', s.owner);
        if (s.date) { q.set('date', s.date); q.set('tz', String(-new Date().getTimezoneOffset())); }
        try {
          const { documents } = await api('/api/documents?' + q);
          $('#res-count').textContent = `${documents.length} result${documents.length === 1 ? '' : 's'}`;
          results.innerHTML = docList(documents, { title: 'No documents match', text: 'Try fewer filters or a different spelling.', cta: false });
        } catch (err) { notify(err.message); }
      }
      $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); notify(''); run(); });
      $('#f-reset').addEventListener('click', () => { state.filters = { q: '', category: '', owner: '', date: '' }; $('#search-form').reset(); $('#f-q').value = $('#f-owner').value = $('#f-date').value = ''; $('#f-cat').value = ''; run(); });
      bindDocActions(results, run); run();
    },
  };
}

async function categoriesPage() {
  const { categories } = await api('/api/categories');
  const html = shell('categories', `<div class="page-head"><div><h1>Categories</h1><p>Browse your documents by type. Select a category to see what’s inside.</p></div></div>
    <div class="cat-grid">${categories.map((c) => `<a class="cat" href="#/documents?category=${encodeURIComponent(c.name)}"><div class="top"><strong>${esc(c.name)}</strong>${icon('grid')}</div><span class="num">${c.count}</span><small>${c.count === 1 ? 'document' : 'documents'} · ${fmtBytes(c.size_bytes)}</small></a>`).join('')}</div>`);
  return { html, bind() {} };
}

async function uploadPage() {
  const { categories } = await api('/api/categories');
  const html = shell('upload', `<div class="page-head"><div><h1>Upload Document</h1><p>Store your files securely and organize them by category.</p></div><a class="btn btn-ghost" href="#/documents">${icon('back')}Back to documents</a></div>
    <section class="card upload-card"><form id="upload-form" novalidate>
      <div class="field"><label for="u-title">Document title *</label><input class="input" id="u-title" maxlength="120" placeholder="e.g. Employment Agreement" required></div>
      <div class="field"><label for="u-desc">Description</label><textarea class="textarea" id="u-desc" maxlength="1000" placeholder="Briefly describe this document"></textarea></div>
      <div class="field"><label for="u-cat">Category *</label><select class="select" id="u-cat">${categories.map((c) => `<option>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><span class="field-label">File *</span><label class="dropzone" id="dropzone">${icon('upload')}<strong>Choose a file or drop it here</strong><span>PDF, TXT, PNG or JPEG · up to 5 MB</span><span class="picked" id="picked"></span><input class="sr-only" id="u-file" type="file" accept="${FILE_ACCEPT}" aria-label="Choose a file"></label></div>
      <p class="alert" id="u-error" role="alert" hidden></p>
      <div class="form-actions"><button class="btn btn-primary" id="u-submit" type="submit">${icon('upload')}Upload document</button><a class="btn btn-ghost" href="#/documents">Cancel</a></div></form></section>`);
  return {
    html, bind() {
      const input = $('#u-file'); const zone = $('#dropzone'); const err = $('#u-error');
      const fail = (m) => { err.textContent = m; err.hidden = false; };
      const picked = () => { const f = input.files?.[0]; $('#picked').textContent = f ? `${f.name} · ${fmtBytes(f.size)}` : ''; if (f && !$('#u-title').value) $('#u-title').value = f.name.replace(/\.[^.]+$/, '').slice(0, 120); };
      input.addEventListener('change', picked);
      ['dragenter', 'dragover'].forEach((n) => zone.addEventListener(n, (e) => { e.preventDefault(); zone.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((n) => zone.addEventListener(n, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
      zone.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) { input.files = e.dataTransfer.files; picked(); } });
      $('#upload-form').addEventListener('submit', async (e) => {
        e.preventDefault(); err.hidden = true;
        const title = $('#u-title').value.trim(); const file = input.files?.[0];
        if (!title) { $('#u-title').focus(); return fail('Enter a document title.'); }
        if (!file) return fail('Choose a file to upload.');
        if (!/\.(pdf|txt|png|jpe?g)$/i.test(file.name)) return fail('Unsupported file type. Upload a PDF, TXT, PNG, or JPEG file.');
        if (file.size > MAX_BYTES) return fail('File exceeds the 5 MB upload limit.');
        const body = new FormData(); body.append('title', title); body.append('description', $('#u-desc').value.trim()); body.append('category', $('#u-cat').value); body.append('file', file);
        const btn = $('#u-submit'); btn.disabled = true; btn.lastChild.textContent = 'Uploading…';
        try { const { document: d } = await api('/api/documents', { method: 'POST', body }); setFlash(`“${d.title}” was uploaded.`); go('/documents'); }
        catch (ex) { fail(ex.message); btn.disabled = false; btn.lastChild.textContent = 'Upload document'; }
      });
    },
  };
}

async function detailPage(id) {
  const { document: d } = await api(`/api/documents/${id}`);
  const me = state.user; const cats = (await api('/api/categories')).categories;
  const users = d.can_share ? (await api('/api/users')).users : [];
  const accessLabel = d.access === 'owner' ? 'Owner' : d.access === 'edit' ? 'Can edit' : d.access === 'admin' ? 'Administrator (read)' : 'Read only';
  const editCard = d.can_edit ? `<section class="card"><div class="card-head"><div><h2>Document details</h2><p>Update the title, description or category.</p></div></div><form id="edit-form" novalidate>
      <div class="field"><label for="e-title">Title *</label><input class="input" id="e-title" maxlength="120" value="${esc(d.title)}" required></div>
      <div class="field"><label for="e-desc">Description</label><textarea class="textarea" id="e-desc" maxlength="1000">${esc(d.description)}</textarea></div>
      <div class="field"><label for="e-cat">Category</label><select class="select" id="e-cat">${cats.map((c) => `<option ${c.name === d.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <button class="btn btn-primary" type="submit">Save changes</button></form></section>` : '';
  const people = d.permissions.length ? d.permissions.map((p) => `<div class="person"><div class="avatar" aria-hidden="true">${initial(p)}</div><div class="person-info"><strong>${esc(p.name)}${p.username ? ` <small>@${esc(p.username)}</small>` : ''}</strong><span>${esc(p.email)}</span></div>
      <div class="person-actions"><span class="tag ${p.can_edit ? 'solid' : ''}">${p.can_edit ? 'Read + Edit' : 'Read only'}</span><button class="btn btn-ghost btn-sm" type="button" data-toggle-edit="${p.user_id}" data-edit="${p.can_edit ? '0' : '1'}">${p.can_edit ? 'Make read-only' : 'Allow edit'}</button><button class="btn btn-danger btn-sm" type="button" data-revoke="${p.user_id}" data-name="${esc(p.name)}">Remove</button></div></div>`).join('')
    : '<p class="hint">Only you can open this document right now.</p>';
  const shareCard = d.can_share ? `<section class="card"><div class="card-head"><div><h2>Grant access</h2><p>Select a registered user and choose the permissions they should receive.</p></div></div>
      ${users.length ? `<form id="grant-form" novalidate><div class="field"><label for="g-user">Select user *</label><select class="select" id="g-user"><option value="">Choose a user</option>${users.map((u) => `<option value="${u.id}">${esc(u.username || u.name)} (${esc(u.email)})</option>`).join('')}</select></div>
      <div class="perm-checks"><label class="check"><input type="checkbox" id="g-read" checked><div><strong>Read access</strong><span>View details and download the file</span></div></label><label class="check"><input type="checkbox" id="g-edit"><div><strong>Edit access</strong><span>Also change title, description and category</span></div></label></div>
      <p class="alert" id="g-error" role="alert" hidden></p><button class="btn btn-primary" type="submit">${icon('users')}Grant access</button></form>` : '<p class="hint">No other users are registered yet. Ask a colleague to create an account, then share this document with them.</p>'}
      <div class="people" id="people"><h3>People with access</h3>${people}</div></section>` : '';
  const html = shell('documents', `<a class="crumb" href="#/documents">${icon('back')}Back to documents</a>
    <section class="card"><div class="detail-hero"><div class="file-mark">${kindOf(d)}</div><div class="detail-grow"><span class="tag">${esc(accessLabel)}</span><h1>${esc(d.title)}</h1><p class="fname">${esc(d.original_name)}</p>
      <div class="meta-row"><span>Owner: <b>${esc(ownerLabel(d, me))}</b></span><span>Category: <b>${esc(d.category)}</b></span><span>Size: <b>${fmtBytes(d.size_bytes)}</b></span><span>Uploaded: <b>${fmtDate(d.created_at)}</b></span></div>
      ${d.description ? `<p class="desc">${esc(d.description)}</p>` : ''}</div>
      <div class="doc-actions"><button class="btn btn-primary" type="button" data-action="download" data-id="${d.id}" data-name="${esc(d.original_name)}">${icon('download')}Download</button>${d.can_delete ? `<button class="btn btn-danger" type="button" data-action="delete" data-id="${d.id}" data-name="${esc(d.title)}">${icon('trash')}Delete</button>` : ''}</div></div></section>${shareCard}${editCard}`);
  return {
    html, bind() {
      const content = $('#content');
      content.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-action="delete"]');
        if (del) { e.stopPropagation(); if (!window.confirm(`Delete “${del.dataset.name}”? This cannot be undone.`)) return;
          try { await api(`/api/documents/${id}`, { method: 'DELETE' }); setFlash('Document deleted.'); go('/documents'); } catch (err) { notify(err.message); } return; }
        const dl = e.target.closest('[data-action="download"]');
        if (dl) { dl.disabled = true; try { await downloadDoc(id, dl.dataset.name); } catch (err) { notify(err.message); } dl.disabled = false; return; }
        const rev = e.target.closest('[data-revoke]');
        if (rev) { if (!window.confirm(`Remove ${rev.dataset.name}’s access to this document?`)) return;
          try { await api(`/api/documents/${id}/permissions/${rev.dataset.revoke}`, { method: 'DELETE' }); setFlash('Access removed.'); render(); } catch (err) { notify(err.message); } return; }
        const tog = e.target.closest('[data-toggle-edit]');
        if (tog) { try { await api(`/api/documents/${id}/permissions`, jsonOpts('POST', { user_id: Number(tog.dataset.toggleEdit), can_read: true, can_edit: tog.dataset.edit === '1' })); setFlash('Permissions updated.'); render(); } catch (err) { notify(err.message); } }
      });
      $('#edit-form')?.addEventListener('submit', async (e) => {
        e.preventDefault(); const title = $('#e-title').value.trim(); if (!title) return notify('Enter a document title.');
        try { await api(`/api/documents/${id}`, jsonOpts('PATCH', { title, description: $('#e-desc').value.trim(), category: $('#e-cat').value })); setFlash('Changes saved.'); render(); } catch (err) { notify(err.message); }
      });
      const edit = $('#g-edit'); const read = $('#g-read');
      edit?.addEventListener('change', () => { if (edit.checked) read.checked = true; read.disabled = edit.checked; });
      $('#grant-form')?.addEventListener('submit', async (e) => {
        e.preventDefault(); const err = $('#g-error'); err.hidden = true;
        const uid = Number($('#g-user').value);
        if (!uid) { err.textContent = 'Choose a user to share with.'; err.hidden = false; return; }
        if (!read.checked && !edit.checked) { err.textContent = 'Select at least one permission.'; err.hidden = false; return; }
        try { await api(`/api/documents/${id}/permissions`, jsonOpts('POST', { user_id: uid, can_read: true, can_edit: edit.checked })); setFlash('Access granted.'); render(); }
        catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });
    },
  };
}

const VERBS = {
  'auth.signin': ['Signed in', 'user'], 'auth.signup': ['Created an account', 'user'], 'auth.logout': ['Signed out', 'logout'],
  'document.upload': ['Uploaded', 'upload'], 'document.download': ['Downloaded', 'download'], 'document.delete': ['Deleted', 'trash'],
  'document.update': ['Edited details of', 'edit'], 'document.view': ['Tried to open', 'docs'],
  'permission.grant': ['Granted access to', 'key'], 'permission.update': ['Changed access on', 'key'], 'permission.revoke': ['Removed access from', 'key'],
  'audit.read': ['Tried to read all activity logs', 'shield'],
};
function logList(logs, emptyText) {
  if (!logs.length) return `<p class="hint">${esc(emptyText)}</p>`;
  const me = state.user;
  return `<div class="log-list">${logs.map((l) => {
    const [verb, ic] = VERBS[l.action] || [l.action, 'clock']; const d = l.details || {};
    const who = l.actor_id === me.id ? 'You' : (l.actor_name || 'Someone');
    const doc = l.resource_type === 'document' ? ` “${esc(d.title || 'document #' + l.resource_id)}”` : '';
    const target = d.target && l.action.startsWith('permission.') ? ` (${esc(d.target)})` : '';
    const denied = l.outcome !== 'success';
    return `<div class="log"><div class="dot">${icon(ic)}</div><div class="log-text"><b>${esc(who)}</b> ${denied && l.action !== 'auth.signin' && l.action !== 'audit.read' ? 'was blocked from: ' + verb.toLowerCase() : denied ? 'failed: ' + verb.toLowerCase() : verb.toLowerCase()}${doc}${target}${denied ? ` <span class="tag denied-tag">${esc(l.outcome)}</span>` : ''}</div><div class="log-time">${fmtDateTime(l.created_at)}</div></div>`;
  }).join('')}</div>`;
}
async function activityPage() {
  const { logs, scope } = await api('/api/audit-logs');
  const html = shell('activity', `<div class="page-head"><div><h1>Activity Logs</h1><p>${scope === 'all' ? 'Every recorded action across TrustVault.' : 'Your actions and activity on documents you own.'}</p></div></div>
    <div class="tabs" role="tablist"><button class="tab active" type="button" data-f="all">All activity</button><button class="tab" type="button" data-f="blocked">Blocked or failed</button></div>
    <section class="card"><div class="card-head"><div><h2>Recent events</h2><p>Up to the latest 200 events</p></div><span class="count-pill" id="log-count">${logs.length} event${logs.length === 1 ? '' : 's'}</span></div><div id="log-body">${logList(logs, 'No activity yet.')}</div></section>`);
  return {
    html, bind() {
      $$('.tab').forEach((t) => t.addEventListener('click', () => {
        $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
        const shown = t.dataset.f === 'blocked' ? logs.filter((l) => l.outcome !== 'success') : logs;
        $('#log-body').innerHTML = logList(shown, t.dataset.f === 'blocked' ? 'Nothing was blocked or failed.' : 'No activity yet.');
        $('#log-count').textContent = `${shown.length} event${shown.length === 1 ? '' : 's'}`;
      }));
    },
  };
}

/* ---------- router ---------- */
const APP_ROUTES = { '/dashboard': dashboardPage, '/documents': documentsPage, '/search': searchPage, '/categories': categoriesPage, '/upload': uploadPage, '/activity': activityPage };
async function render() {
  const seq = ++renderSeq; const { path, params } = parseHash();
  document.title = 'TrustVault — Secure document workspace';
  const detail = path.match(/^\/documents\/(\d+)$/);
  const isApp = path in APP_ROUTES || detail;
  if (state.user && (path === '/signin' || path === '/signup')) return go('/dashboard');
  if (isApp && !state.user) { try { state.user = (await api('/api/auth/me')).user; } catch { return go('/signin'); } }
  if (seq !== renderSeq) return;
  let view;
  try {
    if (path === '/') view = { html: homePage(), bind() {} };
    else if (path === '/about') view = { html: aboutPage(), bind() {} };
    else if (path === '/signin' || path === '/signup') view = { html: authPage(path === '/signup'), bind: () => bindAuth(path === '/signup') };
    else if (detail) view = await detailPage(detail[1]);
    else if (path in APP_ROUTES) view = await APP_ROUTES[path](params);
    else view = { html: publicFrame(`<section class="about"><h1>This page doesn’t exist.</h1><p class="lead">Check the address, or head back to the start.</p><a class="btn btn-primary" href="#/">Back home</a></section>`), bind() {} };
  } catch (err) {
    if (seq !== renderSeq) return;
    if (err.status === 401) { state.user = null; return go('/signin'); }
    if (detail && (err.status === 403 || err.status === 404)) { setFlash(err.message, 'error'); return go('/documents'); }
    view = { html: shell('dashboard', '<div id="flash"></div>'), bind() { notify(err.message); } };
  }
  if (seq !== renderSeq) return;
  root.innerHTML = view.html; if ($('#shell')) bindShell(); view.bind(); showFlash();
  if (!isApp) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => render());
(async () => {
  try { state.user = (await api('/api/auth/me')).user; } catch { state.user = null; }
  if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  render();
})();
