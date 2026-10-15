/* ============================================================
   Monthly Plan — the Instinct bridge (a Cloudflare Worker)

   Instinct (the WhatsApp assistant) can't sign in with Google, so it talks to
   this Worker instead: plain HTTPS + JSON, with a secret bearer token. The
   Worker holds a Google service-account key (as encrypted Worker secrets),
   signs its own short-lived access token with Web Crypto, and reads and writes
   the log through the Firestore REST API — the same documents the app syncs,
   so whatever it changes shows up live on the phone and the laptop.

   The log's shape is the app's: users/{uid}/db/{key}, one document per key
   (a day 'YYYY-MM-DD', or _notes, _deadlines, _mindmaps, …), the value kept
   as JSON text in the field `j`. Every write is conditional on the document's
   last update time, so it can never overwrite a change the app made a moment
   earlier — it re-reads and tries again. Every change is also written to
   users/{uid}/instinct as a log entry holding the value before it, which is
   what /api/undo puts back.

   Secrets (wrangler secret put …): API_SECRET_KEY, FIREBASE_CLIENT_EMAIL,
   FIREBASE_PRIVATE_KEY. Plain vars (wrangler.toml): FIREBASE_PROJECT_ID,
   USER_UID, COLLECTION ('db' for the real log, 'demo' for the demo's),
   TZ_OFFSET_MINUTES (330 = Sri Lanka), READ_ONLY ('1' = only GET is answered).
   ============================================================ */
import { runInbox } from './notion-inbox.js';

/* ---- the app's fixed rules (index.html → CONFIG / SCORING) ---- */
const WATER_TARGET_ML = 3000;
const SLEEP_LO = 6, SLEEP_HI = 8, SLEEP_FALLOFF = 1.5;
const ZONE_GOOD = 60, ZONE_MID = 20;
const JOURNAL_MAX_CHARS = 700;                              // one notepad page (index.html JR_MAX_CHARS)
const NOTE_COLORS = ['sand', 'butter', 'sage', 'rose', 'mist'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (body, status = 200) => new Response(JSON.stringify(body, null, 1),
  { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

/** An error Instinct should read out to the user — said plainly, with what to do instead. */
class Bad extends Error {
  constructor(message, status = 400, extra){ super(message); this.status = status; this.extra = extra; }
}
class Conflict extends Error {}

export default {
  fetch: (request, env) => handle(request, env),
  /* every minute (wrangler.toml [triggers]): apply what Instinct left in the Notion inbox */
  async scheduled(event, env, ctx){ ctx.waitUntil(runInbox(env, handle)); },
};

/** One request. `internal` is the Notion inbox calling its own actions: no key, and the
    read-only switch doesn't apply (it only guards the outside door). */
async function handle(request, env, { internal = false } = {}){
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (path === '' || path === '/api') return json({ ok: true, app: 'Monthly Plan bridge', start: 'GET /api/help' });
    if (!internal){
      await authorize(request, env);
      if (path === '/api/inbox/run') return json({ ok: true, inbox: await runInbox(env, handle) });   // run the inbox now, not at the next minute
      if (env.READ_ONLY === '1' && request.method !== 'GET' && path !== '/api/write-test')
        throw new Bad('This bridge is read-only for now — nothing was changed. Log it in the app.', 403);
    }
    const handler = ROUTES[`${request.method} ${path}`];
    if (!handler) throw new Bad(`No such endpoint: ${request.method} ${url.pathname}. GET /api/help lists them.`, 404);
    const ctx = await makeContext(request, env, url);
    // say on every answer which log this is, so nothing stale in the chat can say otherwise
    const source = ctx.fs.place.docs === 'demo' ? 'demo sample data (for testing)' : 'real log, live';
    return json({ ok: true, source, ...(env.READ_ONLY === '1' && !internal ? { access: 'read-only' } : {}), ...(await handler(ctx)) });
  } catch (err){
    if (err instanceof Bad) return json({ ok: false, error: err.message, ...(err.extra || {}) }, err.status);
    console.error(err);
    return json({ ok: false, error: 'The bridge hit a problem: ' + (err && err.message || err) }, 500);
  }
}

/* ============================================================
   AUTH — the bearer token, compared in constant time
   ============================================================ */
async function authorize(request, env){
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!env.API_SECRET_KEY) throw new Bad('The bridge has no API_SECRET_KEY set.', 500);
  if (!given || !(await sameText(given, env.API_SECRET_KEY))) throw new Bad('Unauthorized', 401);
}
async function sameText(a, b){
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

/* ============================================================
   GOOGLE ACCESS TOKEN — an RS256 JWT signed with Web Crypto
   ============================================================ */
let cachedToken = null;
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = s => b64url(new TextEncoder().encode(s));

async function accessToken(env){
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 300) return cachedToken.token;
  const pem = String(env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  if (!pem || !env.FIREBASE_CLIENT_EMAIL) throw new Bad('The bridge has no service-account key set.', 500);
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const unsigned = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64urlText(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error('Google refused the service-account key: ' + (data.error_description || data.error || res.status));
  cachedToken = { token: data.access_token, expiresAt: now + (data.expires_in || 3600) };
  return cachedToken.token;
}

/* ============================================================
   FIRESTORE — the app's documents over REST
   ============================================================ */
function firestore(env){
  const demo = (env.COLLECTION || 'db') === 'demo';
  const place = { docs: demo ? 'demo' : 'db', config: demo ? 'demo-config' : 'config', log: demo ? 'demo-instinct' : 'instinct' };
  const root = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const user = `users/${env.USER_UID}`;
  async function call(method, path, body){
    const res = await fetch(`${root}/${path}`, {
      method, headers: { Authorization: 'Bearer ' + await accessToken(env), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) return null;
    if (res.status === 409 || res.status === 412 || (data.error && data.error.status === 'FAILED_PRECONDITION')) throw new Conflict();
    if (!res.ok) throw new Error(`Firestore ${method} ${res.status}: ${data.error && data.error.message || ''}`);
    return data;
  }
  const docPath = k => `${user}/${place.docs}/${encodeURIComponent(k)}`;
  const parse = d => (d && d.fields && d.fields.j) ? JSON.parse(d.fields.j.stringValue) : undefined;
  return {
    place,
    async get(k){ const d = await call('GET', docPath(k)); return { value: parse(d), updateTime: d ? d.updateTime : null }; },
    /** Write k, but only if nobody has changed it since `updateTime` (null = it must not exist yet). */
    async put(k, value, updateTime){
      const pre = updateTime ? `currentDocument.updateTime=${encodeURIComponent(updateTime)}` : 'currentDocument.exists=false';
      await call('PATCH', `${docPath(k)}?updateMask.fieldPaths=j&updateMask.fieldPaths=t&${pre}`,
        { fields: { j: { stringValue: JSON.stringify(value) }, t: { timestampValue: new Date().toISOString() } } });
    },
    async del(k, updateTime){ if (updateTime) await call('DELETE', `${docPath(k)}?currentDocument.updateTime=${encodeURIComponent(updateTime)}`); },
    async all(){
      const out = {}; let token = '';
      do {
        const d = await call('GET', `${user}/${place.docs}?pageSize=300${token ? '&pageToken=' + encodeURIComponent(token) : ''}`);
        (d && d.documents || []).forEach(doc => { out[decodeURIComponent(doc.name.split('/').pop())] = parse(doc); });
        token = d && d.nextPageToken;
      } while (token);
      return out;
    },
    async config(){ const d = await call('GET', `${user}/meta/${place.config}`); return d && d.fields && d.fields.j ? JSON.parse(d.fields.j.stringValue) : null; },
    async log(entry){
      await call('POST', `${user}/${place.log}`, { fields: {
        at: { timestampValue: new Date().toISOString() }, what: { stringValue: entry.what },
        key: { stringValue: entry.key }, before: { stringValue: JSON.stringify(entry.before === undefined ? null : entry.before) },
        after: { stringValue: JSON.stringify(entry.after === undefined ? null : entry.after) }, undone: { booleanValue: false },
      } });
    },
    async recent(n){
      const d = await call('GET', `${user}/${place.log}?orderBy=at%20desc&pageSize=${n}`);
      return (d && d.documents || []).map(doc => {
        const f = doc.fields || {};
        return { name: doc.name.split('/documents/')[1], updateTime: doc.updateTime, at: f.at && f.at.timestampValue, what: f.what && f.what.stringValue,
                 key: f.key && f.key.stringValue, before: f.before && JSON.parse(f.before.stringValue), after: f.after && JSON.parse(f.after.stringValue),
                 undone: !!(f.undone && f.undone.booleanValue) };
      });
    },
    async markUndone(entry){ await call('PATCH', `${entry.name}?updateMask.fieldPaths=undone`, { fields: { undone: { booleanValue: true } } }); },
  };
}

/** Read k, change it, write it back — again from the top if the app changed it in between.
    `fn` gets a copy of the current value (undefined if none) and returns the new one. */
async function change(ctx, k, what, fn){
  for (let attempt = 0; attempt < 4; attempt++){
    const cur = await ctx.fs.get(k);
    const next = fn(cur.value === undefined ? undefined : structuredClone(cur.value));
    if (JSON.stringify(next) === JSON.stringify(cur.value)) return next;           // nothing to save
    try {
      if (next === undefined) await ctx.fs.del(k, cur.updateTime);
      else await ctx.fs.put(k, next, cur.updateTime);
    } catch (err){ if (err instanceof Conflict) continue; throw err; }
    await ctx.fs.log({ what, key: k, before: cur.value, after: next });
    return next;
  }
  throw new Bad('The app was saving the same thing at that moment — please try again.', 409);
}

/* ============================================================
   CONTEXT — today, the task list, the request body
   ============================================================ */
async function makeContext(request, env, url){
  if (!env.FIREBASE_PROJECT_ID || !env.USER_UID) throw new Bad('The bridge is missing FIREBASE_PROJECT_ID or USER_UID.', 500);
  const fs = firestore(env);
  let body = {};
  if (request.method !== 'GET'){
    const text = await request.text();
    if (text.trim()) { try { body = JSON.parse(text); } catch { throw new Bad('The request body must be JSON.'); } }
  }
  const offset = Number(env.TZ_OFFSET_MINUTES ?? 330);
  const config = await fs.config() || {};
  for (const k of ['id', 'match']) if (body[k] == null && url.searchParams.get(k)) body[k] = url.searchParams.get(k);
  return { env, url, body, fs, config, offset, today: dayKey(new Date(Date.now() + offset * 60000)), q: k => url.searchParams.get(k) };
}

const pad = n => String(n).padStart(2, '0');
/** A Date already shifted to local time → 'YYYY-MM-DD' (read in UTC so the shift isn't applied twice). */
const dayKey = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDaysKey = (k, n) => { const [y, m, d] = k.split('-').map(Number); return dayKey(new Date(Date.UTC(y, m - 1, d + n))); };
const weekday = k => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const stamp = ctx => { const d = new Date(Date.now() + ctx.offset * 60000); return `${dayKey(d)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 'today' | 'yesterday' | 'tomorrow' | a weekday | 'YYYY-MM-DD' | '20 Oct' → 'YYYY-MM-DD'. */
function parseDate(ctx, s, { future = false } = {}){
  if (s == null || s === '') return ctx.today;
  const t = String(s).trim().toLowerCase();
  let k = null;
  if (t === 'today') k = ctx.today;
  else if (t === 'yesterday') k = addDaysKey(ctx.today, -1);
  else if (t === 'tomorrow') k = addDaysKey(ctx.today, 1);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(t)) k = t;
  else if (DAY_NAMES.some(d => t.replace(/^(next|this|last)\s+/, '') === d)){
    const want = DAY_NAMES.indexOf(t.replace(/^(next|this|last)\s+/, '')), now = weekday(ctx.today);
    const back = (now - want + 7) % 7, ahead = (want - now + 7) % 7 || 7;
    k = future || t.startsWith('next') ? addDaysKey(ctx.today, ahead) : addDaysKey(ctx.today, -back);
  } else {
    const m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*(?:\s+(\d{4}))?$/) || t.match(/^([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/);
    if (m){
      const [day, mon] = /^\d/.test(m[1]) ? [Number(m[1]), m[2]] : [Number(m[2]), m[1]];
      const mi = MONTHS.indexOf(mon);
      if (mi >= 0){
        let y = m[3] ? Number(m[3]) : Number(ctx.today.slice(0, 4));
        k = `${y}-${pad(mi + 1)}-${pad(day)}`;
        if (!m[3] && future && k < ctx.today) k = `${y + 1}-${pad(mi + 1)}-${pad(day)}`;
      }
    }
  }
  if (!k || isNaN(Date.parse(k))) throw new Bad(`I couldn't read the date "${s}". Use YYYY-MM-DD, "today", "yesterday" or a weekday.`);
  return k;
}

/* ============================================================
   TASKS & SCORING — the same rules as index.html
   ============================================================ */
const tasksOf = ctx => Array.isArray(ctx.config.TASKS) ? ctx.config.TASKS : [];
const resolveTask = (t, gym) => { if (!('gym' in t)) return t; const v = gym ? t.gym : t.rest; return v ? { ...t, ...v } : null; };
const appliesOn = (t, k) => !t.since || k >= t.since;
const inferGym = (ctx, e) => (ctx.config.LEGACY_GYM_IDS || []).some(id => e && e.checks && e.checks[id]);
const isGymDay = (ctx, e) => (e && typeof e.gym === 'boolean') ? e.gym : inferGym(ctx, e);
const blankDay = () => ({ checks: {}, water: 0, sleep: null, money: 0, big: [], gym: false });
function waterScore(ml, pts){ const r = Math.min((ml || 0) / WATER_TARGET_ML, 1); return pts * (2 * r - 1); }
function sleepScore(h, pts){
  if (h === null || h === undefined || h === '') return -pts;
  h = Number(h); if (!isFinite(h)) return -pts;
  const dev = h < SLEEP_LO ? SLEEP_LO - h : (h > SLEEP_HI ? h - SLEEP_HI : 0);
  return pts * Math.max(-1, Math.min(1, 1 - dev / SLEEP_FALLOFF));
}
/** The day's score and its parts, exactly as the app's scoreDay() works it out. */
function scoreDay(ctx, k, e){
  e = e || blankDay();
  const gym = isGymDay(ctx, e);
  const parts = tasksOf(ctx).filter(t => !t.unscored).map(t => resolveTask(t, gym)).filter(Boolean).filter(t => appliesOn(t, k)).map(t => {
    let v;
    if (t.type === 'counter') v = waterScore(e.water, t.pts);
    else if (t.type === 'number') v = sleepScore(e.sleep, t.pts);
    else if (e.checks && e.checks[t.id]) v = t.pts;
    else v = t.bonus ? 0 : -t.pts;
    return { t, v };
  });
  const total = Math.round(parts.reduce((s, p) => s + p.v, 0) * 10) / 10;
  const max = parts.reduce((s, p) => s + p.t.pts, 0);
  return { total, max, gym, zone: total >= ZONE_GOOD ? 'Good' : total >= ZONE_MID ? 'Moderate' : 'Bad' };
}

/** The checkbox tasks that exist on day k (both gym and rest wording are accepted when matching). */
function checkTasks(ctx, k, gym){
  return tasksOf(ctx).filter(t => !t.type && appliesOn(t, k)).map(t => {
    const r = resolveTask(t, gym);
    const labels = [t.label, t.gym && t.gym.label, t.rest && t.rest.label].filter(Boolean);
    return r ? { id: t.id, label: r.label, pts: r.pts, group: t.group, bonus: !!t.bonus, labels } : null;
  }).filter(Boolean);
}
const words = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !['the', 'a', 'an', 'my', 'i', 'did', 'done', 'had', 'have', 'to', 'in', 'of', 'for', 'and'].includes(w));
/** The task a phrase means, or a Bad listing what it could be. */
function matchTask(list, phrase){
  const p = String(phrase).toLowerCase().trim();
  const exact = list.find(t => t.id.toLowerCase() === p || t.labels.some(l => l.toLowerCase() === p));
  if (exact) return exact;
  const pw = words(p);
  const scored = list.map(t => {
    const best = Math.max(...t.labels.map(l => {
      const lw = words(l); if (!lw.length || !pw.length) return 0;
      const hit = pw.filter(w => lw.some(x => x === w || (w.length > 3 && x.startsWith(w)) || (x.length > 3 && w.startsWith(x)))).length;
      return hit / Math.max(pw.length, 1) * 0.6 + hit / lw.length * 0.4;
    }));
    return { t, s: best };
  }).sort((a, b) => b.s - a.s);
  if (scored[0] && scored[0].s >= 0.45 && (!scored[1] || scored[0].s - scored[1].s > 0.12)) return scored[0].t;
  const near = scored.filter(x => x.s > 0).slice(0, 4).map(x => x.t.label);
  throw new Bad(`I couldn't tell which task "${phrase}" is.`, 400, { did_you_mean: near.length ? near : list.map(t => t.label) });
}
const isGymPhrase = s => /^(went to (the )?gym|gym( day| session)?|workout|worked out|trained|training)$/i.test(String(s).trim());

/** A day, laid out for reading back. */
function dayView(ctx, k, e){
  const stored = !!e; e = e || blankDay();
  const gym = isGymDay(ctx, e), sc = scoreDay(ctx, k, e);
  const tasks = checkTasks(ctx, k, gym).map(t => ({ task: t.label, group: t.group, points: t.pts, done: !!(e.checks && e.checks[t.id]), ...(t.bonus ? { bonus: true } : {}) }));
  return {
    date: k, weekday: DAY_NAMES[weekday(k)], is_today: k === ctx.today, final: k < ctx.today, logged: stored,
    score: sc.total, max: sc.max, zone: k < ctx.today ? sc.zone : 'In progress',
    gym_day: gym,
    water_ml: e.water || 0, water_target_ml: WATER_TARGET_ML,
    sleep_hours: e.sleep ?? null,
    weight_kg: e.weight ?? null,
    spent: e.money || 0, daily_budget: ctx.config.MONEY_BUDGET || 1000,
    big_purchases: (e.big || []).map(b => ({ amount: b.amt, note: b.note || '' })),
    done: tasks.filter(t => t.done).map(t => t.task),
    not_done: tasks.filter(t => !t.done && !t.bonus).map(t => t.task),
    tasks, journal: e.note || '',
  };
}

/* ============================================================
   ROUTES
   ============================================================ */
const ROUTES = {
  'GET /api/health': async ctx => ({ app: 'Monthly Plan', collection: ctx.fs.place.docs, today: ctx.today, tasks: tasksOf(ctx).length }),
  'GET /api/help': async () => ({ endpoints: HELP }),
  /* proves a POST gets through from the caller — answers even when read-only, and changes nothing */
  'POST /api/write-test': async ctx => ({ received: 'POST', body: ctx.body, changed: 'nothing — this address only confirms that a POST arrived' }),

  /* ---- reading ---- */
  'GET /api/summary': async ctx => {
    const all = await ctx.fs.all();
    const k = ctx.today;
    const week = [];
    for (let i = 1; i <= 7; i++){ const d = addDaysKey(k, -i); if (all[d]) week.push(scoreDay(ctx, d, all[d]).total); }
    const dl = (all._deadlines || []).filter(d => d.status === 'open').sort((a, b) => a.due.localeCompare(b.due));
    return {
      today: dayView(ctx, k, all[k]),
      last_7_days_average: week.length ? Math.round(week.reduce((s, v) => s + v, 0) / week.length * 10) / 10 : null,
      open_deadlines: dl.slice(0, 8).map(d => deadlineView(ctx, d)),
      notes: (all._notes || []).length, mind_maps: (all._mindmaps || []).map(m => m.root.text || '(untitled)'),
    };
  },
  'GET /api/day': async ctx => { const k = parseDate(ctx, ctx.q('date')); return { day: dayView(ctx, k, (await ctx.fs.get(k)).value) }; },
  'GET /api/days': async ctx => {
    const to = parseDate(ctx, ctx.q('to') || 'today'), from = parseDate(ctx, ctx.q('from') || addDaysKey(to, -6));
    if (from > to) throw new Bad('"from" is after "to".');
    const all = await ctx.fs.all(), out = [];
    for (let k = from; k <= to; k = addDaysKey(k, 1)){
      if (out.length > 62) throw new Bad('Ask for at most two months at a time.');
      const v = dayView(ctx, k, all[k]);
      out.push({ date: k, weekday: v.weekday, score: v.score, max: v.max, zone: v.zone, gym_day: v.gym_day, water_ml: v.water_ml, sleep_hours: v.sleep_hours, spent: v.spent, weight_kg: v.weight_kg, not_done: v.not_done });
    }
    const final = out.filter(d => d.date < ctx.today);
    return { days: out, average: final.length ? Math.round(final.reduce((s, d) => s + d.score, 0) / final.length * 10) / 10 : null };
  },
  'GET /api/tasks': async ctx => ({ tasks: checkTasks(ctx, ctx.today, false).map(t => ({ task: t.label, also_called: t.labels.filter(l => l !== t.label), group: t.group, points: t.pts })),
                                    also: ['gym (the "Went to gym" toggle)', 'water_ml', 'sleep_hours', 'weight_kg', 'spent', 'big purchases', 'journal'] }),

  /* ---- the day ---- */
  'POST /api/day': async ctx => {
    const b = ctx.body, k = parseDate(ctx, b.date);
    if (k > ctx.today) throw new Bad("That day hasn't happened yet — days can only be logged up to today.");
    const said = [];
    const after = await change(ctx, k, 'day ' + k, cur => {
      const e = Object.assign(blankDay(), cur || {}, {});
      e.checks = { ...(e.checks || {}) }; e.big = [...(e.big || [])];
      if (typeof (cur && cur.gym) !== 'boolean') e.gym = inferGym(ctx, e);
      said.length = 0;
      const doList = [].concat(b.done || []), undoList = [].concat(b.undone || []);
      for (const [list, val] of [[doList, true], [undoList, false]]){
        for (const phrase of list){
          if (isGymPhrase(phrase)){ e.gym = val; said.push(val ? 'gym ✓' : 'gym ✗'); continue; }
          const t = matchTask(checkTasks(ctx, k, e.gym), phrase);
          if (val) e.checks[t.id] = true; else delete e.checks[t.id];
          said.push(`${t.label} ${val ? '✓' : '✗'}`);
        }
      }
      if (typeof b.gym === 'boolean'){ e.gym = b.gym; said.push(b.gym ? 'gym ✓' : 'gym ✗'); }
      const num = (v, name, lo, hi) => { const n = Number(v); if (!isFinite(n) || n < lo || n > hi) throw new Bad(`${name} must be a number between ${lo} and ${hi}.`); return n; };
      if (b.water_add_ml != null){ e.water = Math.max(0, Math.round((e.water || 0) + num(b.water_add_ml, 'water_add_ml', -10000, 10000))); said.push(`water ${e.water} ml`); }
      if (b.water_ml != null){ e.water = Math.round(num(b.water_ml, 'water_ml', 0, 15000)); said.push(`water ${e.water} ml`); }
      if (b.sleep_hours != null){ e.sleep = Math.round(num(b.sleep_hours, 'sleep_hours', 0, 24) * 4) / 4; said.push(`sleep ${e.sleep} h`); }
      if (b.weight_kg != null){ e.weight = Math.round(num(b.weight_kg, 'weight_kg', 30, 250) * 10) / 10; said.push(`weight ${e.weight} kg`); }
      if (b.spent_add != null){ e.money = Math.max(0, Math.round((e.money || 0) + num(b.spent_add, 'spent_add', -1e7, 1e7))); said.push(`spent ${e.money}`); }
      if (b.spent != null){ e.money = Math.round(num(b.spent, 'spent', 0, 1e7)); said.push(`spent ${e.money}`); }
      // a big purchase logged by mistake: by words from its note and/or its amount; two matches ask back
      for (const p of [].concat(b.remove_big_purchase || [])){
        const want = (p && typeof p === 'object') ? p : (isFinite(Number(p)) && String(p).trim() !== '' ? { amount: p } : { match: p });
        if (want.amount == null && !want.match) throw new Bad('Say which big purchase to remove — words from its note, or its amount.');
        const listed = () => e.big.map(x => ({ amount: x.amt, note: x.note || '' }));
        const hits = e.big.filter(x => (want.amount == null || Math.round(Number(want.amount)) === x.amt)
          && (!want.match || String(x.note || '').toLowerCase().includes(String(want.match).toLowerCase().trim())));
        if (!hits.length) throw new Bad(`No big purchase on ${k} matches that.`, 404, { big_purchases: listed() });
        if (hits.length > 1) throw new Bad('More than one big purchase matches — which one?', 409, { options: hits.map(x => ({ amount: x.amt, note: x.note || '' })) });
        e.big.splice(e.big.indexOf(hits[0]), 1);
        said.push(`removed big purchase ${hits[0].amt}${hits[0].note ? ' (' + hits[0].note + ')' : ''}`);
      }
      for (const p of [].concat(b.big_purchase || [])){
        const amt = Math.round(num(p.amount, 'big_purchase.amount', 1, 1e8));
        e.big.push({ amt, note: String(p.note || '').slice(0, 40) }); said.push(`big purchase ${amt}${p.note ? ' (' + p.note + ')' : ''}`);
      }
      if (b.journal != null || b.journal_append != null){
        const add = String(b.journal_append ?? '').trim();
        let text = b.journal != null ? String(b.journal).trim() : [e.note || '', add].filter(Boolean).join(e.note && !/\s$/.test(e.note) ? ' ' : '');
        if (text.length > JOURNAL_MAX_CHARS)
          throw new Bad(`That doesn't fit on the day's journal page (${JOURNAL_MAX_CHARS} characters). It has ${(e.note || '').length} already — keep it shorter.`);
        if (text) e.note = text; else delete e.note;
        said.push('journal saved');
      }
      if (!said.length) throw new Bad('Nothing to change — say what to log (done, undone, gym, water_add_ml, sleep_hours, weight_kg, spent_add, big_purchase, remove_big_purchase, journal_append).');
      return e;
    });
    return { changed: said, day: dayView(ctx, k, after) };
  },

  /* ---- notes ---- */
  'GET /api/notes': async ctx => ({ notes: ((await ctx.fs.get('_notes')).value || []).map(noteView) }),
  'POST /api/note': async ctx => {
    const text = String(ctx.body.text || '').trim();
    if (!text) throw new Bad('A note needs text.');
    const color = NOTE_COLORS.includes(ctx.body.color) ? ctx.body.color : 'sand';
    const n = { id: newId(), html: textToHtml(text), color, updated: stamp(ctx) };
    await change(ctx, '_notes', 'add note', cur => [n, ...(cur || [])]);
    return { note: noteView(n) };
  },
  'PATCH /api/note': async ctx => {
    let out;
    await change(ctx, '_notes', 'edit note', cur => {
      const list = cur || [], n = pick(list, ctx.body, noteView, 'note');
      if (ctx.body.text != null) n.html = textToHtml(String(ctx.body.text));
      if (ctx.body.append != null) n.html = (n.html ? n.html + '<br>' : '') + textToHtml(String(ctx.body.append));
      if (NOTE_COLORS.includes(ctx.body.color)) n.color = ctx.body.color;
      n.updated = stamp(ctx); out = noteView(n);
      return list;
    });
    return { note: out };
  },
  'DELETE /api/note': async ctx => {
    let gone;
    await change(ctx, '_notes', 'delete note', cur => { const list = cur || [], n = pick(list, ctx.body, noteView, 'note'); gone = noteView(n); return list.filter(x => x !== n); });
    return { deleted: gone };
  },

  /* ---- deadlines (done / cancelled keep them; DELETE removes one added by mistake, like the app's button) ---- */
  'GET /api/deadlines': async ctx => {
    const status = ctx.q('status') || 'open';
    const list = ((await ctx.fs.get('_deadlines')).value || []).filter(d => status === 'all' || d.status === status).sort((a, b) => a.due.localeCompare(b.due));
    return { deadlines: list.map(d => deadlineView(ctx, d)) };
  },
  'POST /api/deadline': async ctx => {
    const title = String(ctx.body.title || '').trim().slice(0, 120);
    if (!title) throw new Bad('A deadline needs a title.');
    const due = parseDate(ctx, ctx.body.due, { future: true });
    const d = { id: newId(), title, due, ...(ctx.body.note ? { note: String(ctx.body.note).slice(0, 200) } : {}), status: 'open', added: ctx.today };
    await change(ctx, '_deadlines', 'add deadline', cur => [...(cur || []), d]);
    return { deadline: deadlineView(ctx, d) };
  },
  'PATCH /api/deadline': async ctx => {
    let out; const b = ctx.body;
    await change(ctx, '_deadlines', 'edit deadline', cur => {
      const list = cur || [], d = pick(list, b, x => deadlineView(ctx, x), 'deadline');
      if (b.status){
        if (!['open', 'done', 'cancelled'].includes(b.status)) throw new Bad('status must be open, done or cancelled.');
        d.status = b.status; if (b.status === 'open') delete d.closed; else d.closed = ctx.today;
      }
      if (b.title) d.title = String(b.title).trim().slice(0, 120);
      if (b.due) d.due = parseDate(ctx, b.due, { future: true });
      if (b.note != null){ if (String(b.note).trim()) d.note = String(b.note).slice(0, 200); else delete d.note; }
      out = deadlineView(ctx, d);
      return list;
    });
    return { deadline: out };
  },

  /* Delete one added by mistake (done / cancelled keep it instead). A mind map linked to it keeps its
     boxes and loses the link — unlinked first, so the deletion is the last change and an undo brings
     the deadline back. */
  'DELETE /api/deadline': async ctx => {
    const target = pick((await ctx.fs.get('_deadlines')).value || [], ctx.body, x => deadlineView(ctx, x), 'deadline');
    const maps = (await ctx.fs.get('_mindmaps')).value || [];
    const linked = maps.some(m => m.deadline === target.id);
    if (linked) await change(ctx, '_mindmaps', 'unlink mind map from deleted deadline',
      cur => (cur || []).map(m => m.deadline === target.id ? (({ deadline, ...rest }) => rest)(m) : m));
    await change(ctx, '_deadlines', 'delete deadline', cur => (cur || []).filter(d => d.id !== target.id));
    return { deleted: target.title, ...(linked ? { mind_map_unlinked: true } : {}) };
  },

  /* ---- mind maps ---- */
  'GET /api/mindmaps': async ctx => ({ mind_maps: ((await ctx.fs.get('_mindmaps')).value || []).map(m => ({ id: m.id, title: m.root.text || '(untitled)', boxes: countBoxes(m.root) - 1 })) }),
  'GET /api/mindmap': async ctx => {
    const list = (await ctx.fs.get('_mindmaps')).value || [];
    const m = pick(list, ctx.body, x => x.root.text, 'mind map');
    return { mind_map: { id: m.id, title: m.root.text, outline: outline(m.root) } };
  },
  'POST /api/mindmap': async ctx => {
    const b = ctx.body, title = String(b.title || '').trim();
    if (!title) throw new Bad('A mind map needs a title.');
    const m = { id: newId(), root: { id: newId(), text: title.slice(0, 80), children: toNodes(b.branches || []) }, updated: stamp(ctx) };
    if (b.deadline){
      const dl = pick((await ctx.fs.get('_deadlines')).value || [], { match: b.deadline }, d => d.title, 'deadline');
      m.deadline = dl.id; m.root.text = dl.title;
    }
    await change(ctx, '_mindmaps', 'add mind map', cur => {
      const list = (cur || []).map(x => (m.deadline && x.deadline === m.deadline) ? (({ deadline, ...rest }) => rest)(x) : x);   // one map per deadline
      return [m, ...list];
    });
    return { mind_map: { id: m.id, title: m.root.text, outline: outline(m.root) } };
  },
  'PATCH /api/mindmap': async ctx => {
    const b = ctx.body; let out;
    await change(ctx, '_mindmaps', 'edit mind map', cur => {
      const list = cur || [], m = pick(list, b, x => x.root.text, 'mind map');
      if (b.add){
        const under = b.add.under ? findNode(m.root, b.add.under) : m.root;
        under.children = [...(under.children || []), ...toNodes(b.add.items || [])];
        delete under.collapsed; delete under.done;
      }
      for (const [name, val] of [['tick', true], ['untick', false]]){
        for (const t of [].concat(b[name] || [])){
          const n = findNode(m.root, t);
          if (n.children && n.children.length) throw new Bad(`"${n.text}" has boxes under it — tick those instead.`);
          if (val) n.done = true; else delete n.done;
        }
      }
      if (b.rename){ const n = b.rename.box ? findNode(m.root, b.rename.box) : m.root; n.text = String(b.rename.to || '').slice(0, 80); }
      if (b.remove){
        for (const t of [].concat(b.remove)){
          const n = findNode(m.root, t);
          if (n === m.root) throw new Bad('To remove a whole map use DELETE /api/mindmap.');
          const drop = p => { p.children = (p.children || []).filter(c => c !== n); p.children.forEach(drop); };
          drop(m.root);
        }
      }
      m.updated = stamp(ctx); out = { id: m.id, title: m.root.text, outline: outline(m.root) };
      return list;
    });
    return { mind_map: out };
  },
  'DELETE /api/mindmap': async ctx => {
    let gone;
    await change(ctx, '_mindmaps', 'delete mind map', cur => { const list = cur || [], m = pick(list, ctx.body, x => x.root.text, 'mind map'); gone = m.root.text; return list.filter(x => x !== m); });
    return { deleted: gone };
  },

  /* ---- safety: what changed, and taking it back ---- */
  'GET /api/log': async ctx => ({ changes: (await ctx.fs.recent(Math.min(Number(ctx.q('limit')) || 10, 30))).map(e => ({ at: e.at, what: e.what, undone: e.undone })) }),
  'POST /api/undo': async ctx => {
    const last = (await ctx.fs.recent(30)).find(e => !e.undone && !/^undo/.test(e.what));
    if (!last) throw new Bad('There is nothing to undo.');
    await change(ctx, last.key, 'undo ' + last.what, cur => {
      if (JSON.stringify(cur ?? null) !== JSON.stringify(last.after)) throw new Bad(`"${last.what}" was changed again in the app since, so I won't undo it — change it back there.`, 409);
      return last.before ?? undefined;
    });
    await ctx.fs.markUndone(last);
    return { undid: last.what, at: last.at };
  },
};

/* ---- helpers for the lists ---- */
function noteView(n){ return { id: n.id, text: htmlToText(n.html), color: n.color, updated: n.updated }; }
function deadlineView(ctx, d){
  const days = Math.round((Date.parse(d.due) - Date.parse(ctx.today)) / 864e5);
  return { id: d.id, title: d.title, due: d.due, status: d.status, ...(d.note ? { note: d.note } : {}),
           when: d.status !== 'open' ? d.status : days < 0 ? `${-days} day${days === -1 ? '' : 's'} overdue` : days === 0 ? 'due today' : days === 1 ? 'tomorrow' : `in ${days} days` };
}
/** One item from a list, by id or by a bit of its text; asks back when it's ambiguous. */
function pick(list, by, view, what){
  if (by.id){ const x = list.find(i => i.id === by.id); if (x) return x; throw new Bad(`No ${what} with id ${by.id}.`, 404); }
  const m = String(by.match || '').toLowerCase().trim();
  if (!m) throw new Bad(`Say which ${what} — give "id" or "match" (a few words of it).`);
  const text = i => String(typeof view(i) === 'string' ? view(i) : (view(i).title || view(i).text || '')).toLowerCase();
  const hits = list.filter(i => text(i).includes(m));
  const pool = hits.length ? hits : list.filter(i => words(m).every(w => text(i).includes(w)));
  if (pool.length === 1) return pool[0];
  const open = pool.filter(i => !i.status || i.status === 'open');
  if (open.length === 1) return open[0];
  if (!pool.length) throw new Bad(`No ${what} matches "${by.match}".`, 404, { options: list.slice(0, 12).map(i => text(i)) });
  throw new Bad(`More than one ${what} matches "${by.match}" — which one?`, 409, { options: pool.slice(0, 8).map(i => ({ id: i.id, text: text(i) })) });
}
const escHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const textToHtml = t => {
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  const bullets = lines.filter(l => /^[-*•]\s+/.test(l));
  if (lines.length > 1 && bullets.length === lines.length) return '<ul>' + lines.map(l => `<li>${escHtml(l.replace(/^[-*•]\s+/, ''))}</li>`).join('') + '</ul>';
  return lines.map(escHtml).join('<br>');
};
const htmlToText = h => String(h || '').replace(/<li>/gi, '\n• ').replace(/<br\s*\/?>|<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\n{2,}/g, '\n').trim();
/** Branches as ["text", {text, children:[…]}, …] or one indented outline string → map nodes. */
function toNodes(items){
  if (typeof items === 'string'){
    const root = { children: [] }, stack = [{ depth: -1, node: root }];
    for (const raw of items.split('\n')){
      if (!raw.trim()) continue;
      const depth = raw.match(/^\s*/)[0].replace(/\t/g, '  ').length;
      const node = { id: newId(), text: raw.trim().replace(/^[-*•]\s*/, '').slice(0, 80), children: [] };
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
      stack[stack.length - 1].node.children.push(node); stack.push({ depth, node });
    }
    return root.children;
  }
  return [].concat(items).map(i => typeof i === 'string' ? { id: newId(), text: i.slice(0, 80), children: [] }
    : { id: newId(), text: String(i.text || '').slice(0, 80), children: toNodes(i.children || []) }).filter(n => n.text);
}
function findNode(root, phrase){
  const p = String(phrase).toLowerCase().trim(), all = [];
  (function walk(n){ all.push(n); (n.children || []).forEach(walk); })(root);
  const hit = all.filter(n => n.text.toLowerCase() === p);
  const pool = hit.length ? hit : all.filter(n => n.text.toLowerCase().includes(p));
  if (pool.length === 1) return pool[0];
  if (!pool.length) throw new Bad(`No box called "${phrase}" in this map.`, 404, { boxes: all.map(n => n.text) });
  throw new Bad(`More than one box matches "${phrase}".`, 409, { options: pool.map(n => n.text) });
}
const countBoxes = n => 1 + (n.children || []).reduce((s, c) => s + countBoxes(c), 0);
const outline = (n, depth = 0) => (depth ? '  '.repeat(depth - 1) + '- ' + n.text + (n.done ? ' ✓' : '') + '\n' : '') + (n.children || []).map(c => outline(c, depth + 1)).join('');

const HELP = [
  'GET  /api/summary — today, last-7-day average, open deadlines, counts',
  'GET  /api/day?date=today|yesterday|YYYY-MM-DD — one day in full',
  'GET  /api/days?from=YYYY-MM-DD&to=YYYY-MM-DD — scores day by day (≤ 2 months)',
  'GET  /api/tasks — the task names to use',
  'POST /api/day {date?, done:[…], undone:[…], gym?, water_add_ml?, water_ml?, sleep_hours?, weight_kg?, spent_add?, spent?, big_purchase?:{amount, note}, remove_big_purchase?:{match?, amount?}, journal_append?, journal?}',
  'GET  /api/notes · POST /api/note {text, color?} · PATCH /api/note {id|match, text?|append?, color?} · DELETE /api/note {id|match}',
  'GET  /api/deadlines?status=open|done|cancelled|all · POST /api/deadline {title, due, note?} · PATCH /api/deadline {id|match, status?, title?, due?, note?} · DELETE /api/deadline {id|match}',
  'GET  /api/mindmaps · GET /api/mindmap?match=… · POST /api/mindmap {title, branches, deadline?} · PATCH /api/mindmap {id|match, add?:{under?, items}, tick?, untick?, rename?:{box?, to}, remove?} · DELETE /api/mindmap {id|match}',
  'GET  /api/log — recent changes made through here · POST /api/undo — take the last one back',
];
