import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PORT = Number(process.env.PORT || 3000);
const APP_SECRET = process.env.APP_SECRET || 'development-only-change-this-secret';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const PLAYER_TTL = 24 * 60 * 60 * 1000;
const MAX_BODY = 128 * 1024;
const playerSessions = new Map();
const adminSessions = new Map();

const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon'
};

await mkdir(DATA_DIR, { recursive: true });
const gameConfig = JSON.parse(await readFile(path.join(ROOT, 'game-settings.json'), 'utf8'));
await ensureStore('accounts.json', { accounts: [] });
await ensureStore('admin.json', { passwordHash: hashPassword(process.env.ADMIN_PASSWORD || 'pnls-admin-2026') });
await ensureStore('models.json', initialModels());

function initialModels() {
  const models = [];
  if (process.env.AI_API_KEY && process.env.AI_BASE_URL && process.env.AI_MODEL) {
    models.push({ id: crypto.randomUUID(), name: process.env.AI_NAME || '默认模型', baseUrl: process.env.AI_BASE_URL, model: process.env.AI_MODEL, apiKey: encrypt(process.env.AI_API_KEY), active: true, createdAt: new Date().toISOString() });
  }
  return { models };
}

async function ensureStore(name, data) {
  const file = path.join(DATA_DIR, name);
  if (!existsSync(file)) await atomicWrite(file, data);
}
async function load(name) { return JSON.parse(await readFile(path.join(DATA_DIR, name), 'utf8')); }
async function save(name, data) { return atomicWrite(path.join(DATA_DIR, name), data); }
async function atomicWrite(file, data) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
function hashPassword(value, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(value), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(value, stored = '') {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(value), salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
function cipherKey() { return crypto.createHash('sha256').update(APP_SECRET).digest(); }
function encrypt(value) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', cipherKey(), iv);
  const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), data.toString('hex')].join('.');
}
function decrypt(value) {
  const [iv, tag, data] = String(value).split('.'); const d = crypto.createDecipheriv('aes-256-gcm', cipherKey(), Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex')); return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(x => x.trim().split(/=(.*)/s).slice(0, 2).map(decodeURIComponent)));
}
function setCookie(res, name, value, maxAge = 43200) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}
function clearCookie(res, name) { res.setHeader('Set-Cookie', `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); }
function send(res, status, payload) {
  const body = JSON.stringify(payload); res.writeHead(status, { 'Content-Type': mime['.json'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body);
}
function fail(res, status, message) { send(res, status, { ok: false, error: message }); }
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > MAX_BODY) throw new Error('请求内容过大'); }
  return raw ? JSON.parse(raw) : {};
}
function safePlayer(req) {
  const token = cookies(req).pnls_session; const s = playerSessions.get(token);
  if (!s || Date.now() - s.lastSeen > PLAYER_TTL) { if (token) playerSessions.delete(token); return null; }
  s.lastSeen = Date.now(); return s;
}
function safeAdmin(req) {
  const token = cookies(req).pnls_admin; const s = adminSessions.get(token);
  if (!s || Date.now() - s.lastSeen > SESSION_TTL) { if (token) adminSessions.delete(token); return null; }
  s.lastSeen = Date.now(); return s;
}
function publicState(state) {
  return { ...state, history: state.history?.slice(-30) || [] };
}
function newGame(name) {
  return {
    playerName: name, turn: 0, chapter: gameConfig.opening.chapter, location: gameConfig.opening.location,
    time: gameConfig.opening.time, hpStatus: '安然无恙', resources: { antibiotic: 30, flashlight: 30, lighter: 999 },
    inventory: [...gameConfig.items.daily], affections: { '苏婉儿': 0, '凌霜': 0, '叶圆圆': 0 }, flags: {},
    narrative: gameConfig.opening.intro.replaceAll('你', name), options: gameConfig.opening.options,
    summary: `${name}在平阳县北门码头旁的河心亭醒来，发现自己穿越到南宋。`, history: [], updatedAt: new Date().toISOString()
  };
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n))); }
function mergePatch(state, patch = {}) {
  const next = structuredClone(state);
  for (const key of ['chapter', 'location', 'time', 'hpStatus']) if (typeof patch[key] === 'string') next[key] = patch[key].slice(0, 120);
  if (patch.resources && typeof patch.resources === 'object') {
    next.resources.antibiotic = clamp(patch.resources.antibiotic ?? next.resources.antibiotic, 0, 30);
    next.resources.flashlight = clamp(patch.resources.flashlight ?? next.resources.flashlight, 0, 30);
    next.resources.lighter = clamp(patch.resources.lighter ?? next.resources.lighter, 0, 999);
  }
  if (patch.affections && typeof patch.affections === 'object') {
    for (const name of Object.keys(next.affections)) if (Number.isFinite(Number(patch.affections[name]))) next.affections[name] = clamp(patch.affections[name], -50, 100);
  }
  if (Array.isArray(patch.inventory)) next.inventory = patch.inventory.filter(x => typeof x === 'string').slice(0, 30);
  if (patch.flags && typeof patch.flags === 'object') next.flags = { ...next.flags, ...patch.flags };
  return next;
}
function accountView(a) { return { id: a.id, name: a.name, totalSeconds: a.totalSeconds || 0, turns: a.game?.turn || 0, lastPlayedAt: a.lastPlayedAt, createdAt: a.createdAt }; }

async function routeApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, modelConfigured: (await load('models.json')).models.some(x => x.active) });
  if (req.method === 'POST' && url.pathname === '/api/game/login') {
    const data = await body(req); const name = String(data.name || '').trim().slice(0, 20); const password = String(data.password || ''); const mode = data.mode;
    if (!/^[\p{L}\p{N}_·\-]{1,20}$/u.test(name)) return fail(res, 400, '姓名须为1至20个汉字、字母或数字');
    if (!/^\d{6}$/.test(password)) return fail(res, 400, '密码必须是六位数字');
    if (!['continue', 'restart'].includes(mode)) return fail(res, 400, '请选择继续游戏或重新开始');
    const db = await load('accounts.json'); let account = db.accounts.find(x => x.nameKey === name.toLocaleLowerCase('zh-CN'));
    if (account && !verifyPassword(password, account.passwordHash)) return fail(res, 401, '姓名或密码不正确');
    if (!account && mode === 'continue') return fail(res, 404, '未找到该角色存档，请选择“重新开始”');
    if (!account) { account = { id: crypto.randomUUID(), name, nameKey: name.toLocaleLowerCase('zh-CN'), passwordHash: hashPassword(password), game: newGame(name), totalSeconds: 0, createdAt: new Date().toISOString(), lastPlayedAt: new Date().toISOString() }; db.accounts.push(account); await save('accounts.json', db); }
    if (mode === 'restart') { account.name = name; account.game = newGame(name); account.lastPlayedAt = new Date().toISOString(); await save('accounts.json', db); }
    const token = crypto.randomBytes(32).toString('hex'); playerSessions.set(token, { accountId: account.id, draft: structuredClone(account.game), dirty: false, lastSeen: Date.now(), activeSeconds: 0 }); setCookie(res, 'pnls_session', token, 86400);
    return send(res, 200, { ok: true, state: publicState(account.game) });
  }
  if (req.method === 'GET' && url.pathname === '/api/game/state') { const s = safePlayer(req); if (!s) return fail(res, 401, '请先进入游戏'); return send(res, 200, { ok: true, state: publicState(s.draft), dirty: s.dirty }); }
  if (req.method === 'POST' && url.pathname === '/api/game/heartbeat') { const s = safePlayer(req); if (!s) return fail(res, 401, '登录已失效'); s.activeSeconds += 30; return send(res, 200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/game/turn') {
    const s = safePlayer(req); if (!s) return fail(res, 401, '请先进入游戏'); const data = await body(req); const input = String(data.input || '').trim().slice(0, 500); if (!input) return fail(res, 400, '请输入行动');
    const result = await runAiTurn(s.draft, input); let next = mergePatch(s.draft, result.patch); next.turn += 1; next.narrative = result.narrative; next.options = result.options; next.summary = result.summary || next.summary; next.updatedAt = new Date().toISOString();
    next.history = [...(next.history || []), { turn: next.turn, input, narrative: result.narrative, options: result.options }].slice(-60); s.draft = next; s.dirty = true;
    return send(res, 200, { ok: true, state: publicState(next), dirty: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/game/save') { const s = safePlayer(req); if (!s) return fail(res, 401, '请先进入游戏'); await persistSession(s); s.dirty = false; return send(res, 200, { ok: true, message: '进度已保存' }); }
  if (req.method === 'POST' && url.pathname === '/api/game/quit') { const s = safePlayer(req); if (!s) return fail(res, 401, '请先进入游戏'); const data = await body(req); if (data.save) await persistSession(s); const token = cookies(req).pnls_session; playerSessions.delete(token); clearCookie(res, 'pnls_session'); return send(res, 200, { ok: true }); }

  if (req.method === 'POST' && url.pathname === '/api/admin/login') { const data = await body(req); const admin = await load('admin.json'); if (!verifyPassword(String(data.password || ''), admin.passwordHash)) return fail(res, 401, '管理密码错误'); const token = crypto.randomBytes(32).toString('hex'); adminSessions.set(token, { lastSeen: Date.now() }); setCookie(res, 'pnls_admin', token); return send(res, 200, { ok: true }); }
  if (url.pathname.startsWith('/api/admin/') && !safeAdmin(req)) return fail(res, 401, '管理员登录已失效');
  if (req.method === 'GET' && url.pathname === '/api/admin/dashboard') { const [db, md] = await Promise.all([load('accounts.json'), load('models.json')]); return send(res, 200, { ok: true, accounts: db.accounts.map(accountView), models: md.models.map(x => ({ ...x, apiKey: undefined, hasKey: true })) }); }
  if (req.method === 'POST' && url.pathname === '/api/admin/password') { const data = await body(req); const admin = await load('admin.json'); if (!verifyPassword(String(data.currentPassword || ''), admin.passwordHash)) return fail(res, 400, '原密码不正确'); if (String(data.newPassword || '').length < 8) return fail(res, 400, '新密码至少8位'); admin.passwordHash = hashPassword(data.newPassword); await save('admin.json', admin); return send(res, 200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/admin/models') {
    const data = await body(req); if (![data.name, data.baseUrl, data.model, data.apiKey].every(x => String(x || '').trim())) return fail(res, 400, '请填写完整模型信息');
    let parsed; try { parsed = new URL(data.baseUrl); } catch { return fail(res, 400, '接口地址无效'); } if (parsed.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && parsed.protocol === 'http:')) return fail(res, 400, '生产环境接口必须使用 HTTPS');
    const md = await load('models.json'); const item = { id: crypto.randomUUID(), name: String(data.name).slice(0, 40), baseUrl: parsed.toString().replace(/\/$/, ''), model: String(data.model).slice(0, 100), apiKey: encrypt(String(data.apiKey)), active: md.models.length === 0, createdAt: new Date().toISOString() }; md.models.push(item); await save('models.json', md); return send(res, 200, { ok: true });
  }
  const activeMatch = url.pathname.match(/^\/api\/admin\/models\/([^/]+)\/active$/); if (req.method === 'POST' && activeMatch) { const md = await load('models.json'); if (!md.models.some(x => x.id === activeMatch[1])) return fail(res, 404, '模型不存在'); md.models.forEach(x => x.active = x.id === activeMatch[1]); await save('models.json', md); return send(res, 200, { ok: true }); }
  const deleteMatch = url.pathname.match(/^\/api\/admin\/models\/([^/]+)$/); if (req.method === 'DELETE' && deleteMatch) { const md = await load('models.json'); md.models = md.models.filter(x => x.id !== deleteMatch[1]); await save('models.json', md); return send(res, 200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/admin/logout') { adminSessions.delete(cookies(req).pnls_admin); clearCookie(res, 'pnls_admin'); return send(res, 200, { ok: true }); }
  return fail(res, 404, '接口不存在');
}

async function persistSession(s) {
  const db = await load('accounts.json'); const account = db.accounts.find(x => x.id === s.accountId); if (!account) throw new Error('账号不存在'); account.game = structuredClone(s.draft); account.totalSeconds = (account.totalSeconds || 0) + s.activeSeconds; s.activeSeconds = 0; account.lastPlayedAt = new Date().toISOString(); await save('accounts.json', db);
}
function chatEndpoint(baseUrl) { const u = baseUrl.replace(/\/$/, ''); return /\/chat\/completions$/i.test(u) ? u : `${u}/chat/completions`; }
async function runAiTurn(state, input) {
  const md = await load('models.json'); const provider = md.models.find(x => x.active); if (!provider) throw Object.assign(new Error('尚未配置可用的 AI 模型，请联系管理员'), { public: true });
  const prompt = `你是《${gameConfig.title}》武侠MUD的叙事引擎。严格遵守以下完整设定：\n${JSON.stringify(gameConfig)}\n\n当前游戏状态：\n${JSON.stringify({ ...state, history: state.history.slice(-8) })}\n\n玩家本轮行动：${input}\n\n重要：第${state.turn + 1}回合；未达到女主最早登场回合时不得让其出现。主角永不死亡。只返回设定要求的JSON。`;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 90000);
  let response;
  try { response = await fetch(chatEndpoint(provider.baseUrl), { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${decrypt(provider.apiKey)}` }, body: JSON.stringify({ model: provider.model, messages: [{ role: 'system', content: '你是严谨、连续、有文学表现力的中文MUD游戏引擎。必须输出合法JSON，不使用Markdown。' }, { role: 'user', content: prompt }] }) }); } finally { clearTimeout(timer); }
  if (!response.ok) { const detail = (await response.text()).slice(0, 500); console.error('AI provider error', response.status, detail); throw Object.assign(new Error(`AI 接口返回 ${response.status}`), { public: true }); }
  const envelope = await response.json(); const raw = envelope.choices?.[0]?.message?.content; if (!raw) throw Object.assign(new Error('AI 未返回有效剧情'), { public: true });
  let result; try { result = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '')); } catch { throw Object.assign(new Error('AI 返回格式无法解析，请重试'), { public: true }); }
  if (typeof result.narrative !== 'string' || !Array.isArray(result.options) || result.options.length !== 4) throw Object.assign(new Error('AI 返回的剧情结构不完整，请重试'), { public: true });
  result.narrative = result.narrative.slice(0, 5000); result.options = result.options.map(x => String(x).slice(0, 160)); result.summary = String(result.summary || state.summary).slice(0, 1200); return result;
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname); if (pathname === '/') pathname = '/index.html'; if (pathname === '/admin') pathname = '/admin.html';
  const allowed = new Set(['/index.html', '/style.css', '/app.js', '/admin.html', '/admin.js', '/pnlsbanner.png']); if (!allowed.has(pathname)) return fail(res, 404, '页面不存在');
  const file = path.join(ROOT, pathname.slice(1)); try { const data = await readFile(file); res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': pathname.endsWith('.html') ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); res.end(data); } catch { fail(res, 404, '文件不存在'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try { if (url.pathname.startsWith('/api/')) await routeApi(req, res, url); else await serveStatic(req, res, url); }
  catch (err) { console.error(err); fail(res, err.public ? 502 : 500, err.public ? err.message : '服务器暂时出了问题，请稍后再试'); }
});
server.listen(PORT, '0.0.0.0', () => console.log(`坡南龙蛇已启动：http://0.0.0.0:${PORT}`));
