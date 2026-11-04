const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { ApiError } = require('../middleware/errors');
const store = require('./store');

const scrypt = promisify(crypto.scrypt);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const COOKIE = 'fraudshield_session';
// Keep the local demo signed in across browser and backend restarts.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const users = new Map();
const sessions = new Map();
const attempts = new Map();
const signupAttempts = new Map();
let setupInProgress = false;

try {
  const saved = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  for (const user of saved) users.set(user.username, user);
} catch { /* First run: the initial administrator is created through the setup form. */ }
try {
  const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  for (const [key, session] of Object.entries(saved)) {
    if (session.expiresAt > Date.now() && [...users.values()].some((user) => user.id === session.userId)) sessions.set(key, session);
  }
} catch { /* Sessions are created after the first successful sign-in. */ }

const publicUser = (user) => ({ id: user.id, username: user.username, display_name: user.display_name,
  role: user.role, bank_user_id: user.bank_user_id || null, created_at: user.created_at });
const admins = () => [...users.values()].filter((u) => u.role === 'admin');
const saveUsers = () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify([...users.values()], null, 2), { mode: 0o600 });
};
const normalizeUsername = (value) => String(value || '').trim().toLowerCase();
const sessionKey = (token) => crypto.createHash('sha256').update(token).digest('hex');
const saveSessions = () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
};
const hashPassword = async (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt, hash: (await scrypt(password, salt, 64)).toString('hex'),
});
const passwordValid = (password) => typeof password === 'string' && password.length >= 12 && password.length <= 128;
const readCookie = (req) => {
  const raw = req.headers.cookie || '';
  const found = raw.split(';').map((x) => x.trim()).find((x) => x.startsWith(`${COOKIE}=`));
  if (!found) return '';
  try { return decodeURIComponent(found.slice(COOKIE.length + 1)); } catch { return ''; }
};
const cookieOptions = () => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`;
function issueSession(user, res) {
  for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  sessions.set(sessionKey(token), { userId: user.id, csrf, expiresAt: Date.now() + SESSION_TTL_MS });
  saveSessions();
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; ${cookieOptions()}`);
  return csrf;
}
function clearSession(req, res) {
  const token = readCookie(req);
  if (token && sessions.delete(sessionKey(token))) saveSessions();
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
}
function checkLoginRate(req, username) {
  const key = `${req.ip}:${username}`;
  const now = Date.now(), previous = attempts.get(key) || { count: 0, since: now };
  if (now - previous.since > 15 * 60 * 1000) { previous.count = 0; previous.since = now; }
  if (previous.count >= 8) throw new ApiError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
  attempts.set(key, previous);
  return key;
}
const auth = {
  status(req, res) {
    const token = readCookie(req), session = sessions.get(sessionKey(token));
    if (session && session.expiresAt > Date.now()) {
      const user = [...users.values()].find((u) => u.id === session.userId);
      if (user) return res.json({ setup_required: admins().length === 0, user: publicUser(user), csrf_token: session.csrf });
    }
    if (token) sessions.delete(sessionKey(token));
    return res.json({ setup_required: admins().length === 0, user: null, csrf_token: null });
  },
  async setup(req, res) {
    const remoteAddress = req.socket.remoteAddress;
    if (!['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
      throw new ApiError(403, 'Initial administrator setup is only available from this machine.');
    }
    if (admins().length || setupInProgress) throw new ApiError(409, 'Initial administrator setup has already been completed.');
    if (req.get('content-type')?.split(';')[0] !== 'application/json') throw new ApiError(415, 'Send setup details as JSON.');
    const username = normalizeUsername(req.body?.username);
    const displayName = String(req.body?.display_name || '').trim().slice(0, 80);
    const password = req.body?.password;
    if (!/^[a-z0-9._@+-]{3,120}$/.test(username)) throw new ApiError(400, 'Enter a valid email or username (3–120 characters).');
    if (!displayName) throw new ApiError(400, 'Display name is required.');
    if (!passwordValid(password)) throw new ApiError(400, 'Password must be 12–128 characters.');
    setupInProgress = true;
    try {
      const credentials = await hashPassword(password);
      const user = { id: crypto.randomUUID(), username, display_name: displayName, role: 'admin', ...credentials, created_at: new Date().toISOString() };
      users.set(username, user); saveUsers();
      return res.status(201).json({ user: publicUser(user), csrf_token: issueSession(user, res) });
    } finally { setupInProgress = false; }
  },
  async login(req, res) {
    if (req.get('content-type')?.split(';')[0] !== 'application/json') throw new ApiError(415, 'Send sign-in details as JSON.');
    const username = normalizeUsername(req.body?.username), key = checkLoginRate(req, username);
    const user = users.get(username), password = typeof req.body?.password === 'string' ? req.body.password : '';
    let valid = false;
    if (user) {
      const candidate = await scrypt(password, user.salt, 64);
      valid = crypto.timingSafeEqual(candidate, Buffer.from(user.hash, 'hex'));
    }
    if (!valid) { attempts.get(key).count += 1; throw new ApiError(401, 'Username or password is incorrect.'); }
    attempts.delete(key);
    return res.json({ user: publicUser(user), csrf_token: issueSession(user, res) });
  },
  async signup(req, res) {
    if (req.get('content-type')?.split(';')[0] !== 'application/json') throw new ApiError(415, 'Send sign-up details as JSON.');
    const ip = req.ip || req.socket.remoteAddress || 'unknown', now = Date.now();
    const rate = signupAttempts.get(ip) || { count: 0, since: now };
    if (now - rate.since > 15 * 60 * 1000) { rate.count = 0; rate.since = now; }
    if (rate.count >= 5) throw new ApiError(429, 'Too many sign-up attempts. Try again in 15 minutes.');
    rate.count += 1; signupAttempts.set(ip, rate);
    const username = normalizeUsername(req.body?.username);
    const displayName = String(req.body?.display_name || '').trim().slice(0, 80);
    const bankUserId = String(req.body?.bank_user_id || '').trim().slice(0, 120);
    const password = req.body?.password;
    if (!/^[a-z0-9._@+-]{3,120}$/.test(username)) throw new ApiError(400, 'Enter a valid email or username.');
    if (users.has(username)) throw new ApiError(409, 'That username already exists.');
    if (!displayName) throw new ApiError(400, 'Display name is required.');
    if (!bankUserId) throw new ApiError(400, 'Bank user ID is required.');
    if (!store.all().some((tx) => String(tx.user_id) === bankUserId)) throw new ApiError(400, 'That bank user ID was not found in transaction records. Check the ID or contact your administrator.');
    if ([...users.values()].some((u) => u.role === 'bank_user' && u.bank_user_id === bankUserId)) throw new ApiError(409, 'An account is already registered for that bank user ID. Contact your administrator.');
    if (!passwordValid(password)) throw new ApiError(400, 'Password must be 12–128 characters.');
    const credentials = await hashPassword(password);
    const user = { id: crypto.randomUUID(), username, display_name: displayName, role: 'bank_user', bank_user_id: bankUserId, ...credentials, created_at: new Date().toISOString() };
    users.set(username, user); saveUsers();
    return res.status(201).json({ user: publicUser(user), csrf_token: issueSession(user, res) });
  },
  logout(req, res) { clearSession(req, res); res.json({ ok: true }); },
  requireAuth(req, res, next) {
    const token = readCookie(req), session = sessions.get(sessionKey(token));
    if (!session || session.expiresAt <= Date.now()) {
      if (token && sessions.delete(sessionKey(token))) saveSessions();
      return next(new ApiError(401, 'Sign in to continue.'));
    }
    const user = [...users.values()].find((u) => u.id === session.userId);
    if (!user) return next(new ApiError(401, 'This account is no longer active.'));
    req.auth = { ...publicUser(user), csrf: session.csrf };
    req.sessionToken = token;
    return next();
  },
  verifyCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const supplied = req.get('x-csrf-token') || '';
    const expected = req.auth?.csrf || '';
    const a = Buffer.from(supplied), b = Buffer.from(expected);
    if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return next(new ApiError(403, 'Request verification failed. Refresh and try again.'));
    return next();
  },
  requireAdmin(req, res, next) {
    if (req.auth?.role !== 'admin') return next(new ApiError(403, 'Administrator access is required.'));
    return next();
  },
  async createUser(req, res) {
    const username = normalizeUsername(req.body?.username);
    const displayName = String(req.body?.display_name || '').trim().slice(0, 80);
    const bankUserId = String(req.body?.bank_user_id || '').trim().slice(0, 120);
    const password = req.body?.password;
    const role = req.body?.role;
    if (!/^[a-z0-9._@+-]{3,120}$/.test(username)) throw new ApiError(400, 'Enter a valid email or username.');
    if (users.has(username)) throw new ApiError(409, 'That username already exists.');
    if (!displayName) throw new ApiError(400, 'Display name is required.');
    if (role !== 'bank_user') throw new ApiError(400, 'New accounts must use the bank_user role.');
    if (!bankUserId) throw new ApiError(400, 'Bank user ID is required to scope account data.');
    if (!passwordValid(password)) throw new ApiError(400, 'Temporary password must be 12–128 characters.');
    const credentials = await hashPassword(password);
    const user = { id: crypto.randomUUID(), username, display_name: displayName, role, bank_user_id: bankUserId, ...credentials, created_at: new Date().toISOString() };
    users.set(username, user); saveUsers();
    return res.status(201).json({ user: publicUser(user) });
  },
  listUsers(req, res) { res.json([...users.values()].map(publicUser)); },
};

module.exports = auth;
