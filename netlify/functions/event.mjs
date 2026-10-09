// One function, two routes (via netlify.toml rewrites):
//   POST /api/event            stores one raw row per event in Netlify Blobs (store "events", key day/hour/id-event)
//   GET  /admin?key=ADMIN_KEY  counts per day: uniques (by vid) per utm_source and blended, taps, emails, answers
//
// Rows are never deduped on write. Closed hours are summarised once (counts and vid lists only, no
// addresses or answers) and cached in the "summaries" store; the email and answer tables always read
// the raw rows, so deleting a row in "events" is the only deletion needed.
// Rows with utm_campaign=smoke, rows without utm_source and visitors with a gate pageview received before
// GATE_START are stored but kept out of the gate counts.

import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Gate A starts 2026-10-13 12:00 AM CDT. A visitor with a gate pageview received (server time) before it is excluded for good.
const GATE_START = Date.parse('2026-10-13T05:00:00.000Z');
const EVENTS = new Set(['pageview', 'tap', 'email', 'answer', 'video', 'seen', 'leave']);
const DEVICES = new Set(['ios', 'android', 'other']);
const INAPPS = new Set(['tiktok', 'instagram', 'facebook', 'none']);
const VIDEO_STATES = new Set(['playing', 'blocked']);
const BUTTONS = new Set(['card', 'bar']);
const VID_RE = /^[a-z0-9]{24}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 8192;
const COOKIE_MAX_AGE = 90 * 24 * 60 * 60;
const SUMMARY_VERSION = 5;
const BOT_UA = /facebookexternalhit|Facebot|meta-external|Bytespider|TikTokSpider|Googlebot|AdsBot|HeadlessChrome|PhantomJS|Lighthouse/i;
const HOUR_GRACE_MS = 2 * 60 * 1000;
const READ_CONCURRENCY = 32;
const HOUR_CONCURRENCY = 4;
const ADMIN_BUDGET_MS = 8000;
const SITE_ORIGINS = ['https://restline.app', 'https://www.restline.app'];

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const isAdmin = req.method === 'GET' || path.endsWith('/admin');
  try {
    if (isAdmin) return await admin(req, url);
    if (req.method === 'POST') return await event(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: noStore() });
    return json({ error: 'method not allowed' }, 405, { Allow: 'POST' });
  } catch (err) {
    console.error(err);
    return json({ error: 'internal error' }, 500);
  }
}

/* ---------------- POST /api/event ---------------- */

async function event(req) {
  const origin = req.headers.get('origin');
  if (origin && !allowedOrigin(origin)) return json({ error: 'forbidden' }, 403);

  let text;
  try { text = await req.text(); } catch { return json({ error: 'bad body' }, 400); }
  if (text.length > MAX_BODY) return json({ error: 'too large' }, 413);
  let data;
  try { data = JSON.parse(text); } catch { return json({ error: 'bad json' }, 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'bad json' }, 400);

  const name = str(data.event, 16);
  if (!EVENTS.has(name)) return json({ error: 'bad event' }, 400);
  const vid = str(data.vid, 64);
  if (!VID_RE.test(vid)) return json({ error: 'bad vid' }, 400);

  const now = new Date();
  const received = now.toISOString();
  const row = {
    event: name,
    vid,
    ts: validTs(data.ts) || received,
    received,
    utm_source: clean(data.utm_source, 100),
    utm_medium: clean(data.utm_medium, 100),
    utm_campaign: clean(data.utm_campaign, 100),
    utm_content: clean(data.utm_content, 100),
    device: DEVICES.has(data.device) ? data.device : 'other',
    inapp: INAPPS.has(data.inapp) ? data.inapp : 'none',
    ref: refOrigin(data.ref)
  };
  row.flag = flagOf(row);

  if (name === 'pageview') {
    row.ua = clean(data.ua, 160);
    row.wd = data.wd === true;
    row.scr = clean(data.scr, 12);
  } else if (name === 'email') {
    const email = clean(data.email, 254);
    if (!looksLikeEmail(email)) return json({ error: 'bad email' }, 400);
    row.email = email;
  } else if (name === 'answer') {
    const answer = clean(data.answer, 1000);
    if (!answer) return json({ error: 'empty answer' }, 400);
    row.answer = answer;
  } else if (name === 'video') {
    if (!VIDEO_STATES.has(data.video)) return json({ error: 'bad video state' }, 400);
    row.video = data.video;
  } else if (name === 'leave') {
    const s = Number(data.seconds);
    row.seconds = Number.isFinite(s) ? Math.min(Math.max(Math.round(s), 0), 7 * 24 * 3600) : 0;
  } else if (name === 'tap' && BUTTONS.has(data.button)) {
    row.button = data.button;
  }

  const day = received.slice(0, 10);
  const hour = received.slice(11, 13);
  const key = `${day}/${hour}/${now.getTime()}-${randomBytes(4).toString('hex')}-${name}`;
  const store = getStore({ name: 'events', consistency: 'strong' });
  await store.setJSON(key, row);

  return new Response(null, {
    status: 204,
    headers: {
      ...noStore(),
      'Set-Cookie': `rl_v=${vid}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax; Secure`
    }
  });
}

function allowedOrigin(origin) {
  const allowed = new Set(SITE_ORIGINS);
  for (const v of [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL]) if (v) allowed.add(v.replace(/\/$/, ''));
  if (allowed.has(origin)) return true;
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1';
  } catch { return false; }
}

function flagOf(row) {
  if (row.utm_campaign.toLowerCase() === 'smoke') return 'smoke';
  if (!row.utm_source) return 'no_utm';
  return 'gate';
}

/* ---------------- GET /admin ---------------- */

async function admin(req, url) {
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405, { Allow: 'GET' });
  const expected = process.env.ADMIN_KEY;
  if (!expected) return json({ error: 'ADMIN_KEY is not set in the Netlify environment' }, 503);
  if (!safeEqual(url.searchParams.get('key') || '', expected)) return json({ error: 'unauthorized' }, 401);

  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json';
  const table = url.searchParams.get('table') || 'summary';
  const only = dayParam(url.searchParams.get('day'));
  const from = only || dayParam(url.searchParams.get('from'));
  const to = only || dayParam(url.searchParams.get('to'));
  const deadline = Date.now() + ADMIN_BUDGET_MS;

  const events = getStore({ name: 'events', consistency: 'strong' });
  const summaries = getStore({ name: 'summaries', consistency: 'strong' });

  const allDays = (await listDirs(events, '')).filter((d) => DAY_RE.test(d)).sort();
  const days = allDays.filter((d) => (!from || d >= from) && (!to || d <= to));

  if (table === 'raw') {
    if (!only) return json({ error: 'table=raw needs day=YYYY-MM-DD' }, 400);
    const keys = await listKeys(events, `${only}/`);
    const read = await readRows(events, keys, deadline);
    read.rows.sort(byReceived);
    const partial = read.failed > 0 || read.skipped > 0;
    if (format === 'csv') return csv(read.rows, RAW_COLUMNS, `restline-raw-${only}.csv`, partial);
    return json({ day: only, partial, failed: read.failed, skipped: read.skipped, rows: read.rows }, 200, noStore());
  }

  if (table === 'emails' || table === 'answers') {
    const want = table === 'emails' ? 'email' : 'answer';
    const columns = want === 'email' ? EMAIL_COLUMNS : ANSWER_COLUMNS;
    const got = await eventRows(events, days, want, deadline);
    const list = got.rows.map((r) => pick(r, columns));
    const partial = got.failed > 0 || got.skipped > 0;
    if (format === 'csv') return csv(list, columns, want === 'email' ? 'restline-emails.csv' : 'restline-answers.csv', partial);
    return json({ generated: new Date().toISOString(), partial, [table]: list }, 200, noStore());
  }

  const perDay = [];
  const pending = [];
  let failed = 0;
  const summarize = (day, hours) => mapLimit(hours, HOUR_CONCURRENCY, async (hour) => {
    if (Date.now() > deadline) { pending.push(`${day}/${hour}`); return null; }
    try {
      return await hourSummary(events, summaries, day, hour);
    } catch (err) {
      console.error('hour failed', day, hour, err);
      const s = newSummary(day, hour);
      s.failed = 1;
      return s;
    }
  });
  for (const day of days) {
    const hours = (await listDirs(events, `${day}/`)).sort();
    const merged = newSummary(day, '');
    for (const h of await summarize(day, hours)) {
      if (!h) continue;
      failed += h.failed || 0;
      mergeSummary(merged, h);
    }
    perDay.push(merged);
  }
  // Pre-start visitors are excluded for good, so their ids come from every hour before GATE_START,
  // including the hours of days outside the requested range.
  const prestart = new Set();
  for (const d of perDay) for (const v of d.pre) prestart.add(v);
  for (const day of allDays) {
    if (days.includes(day) || Date.parse(`${day}T00:00:00Z`) >= GATE_START) continue;
    const hours = (await listDirs(events, `${day}/`)).filter((h) => Date.parse(`${day}T${h}:00:00Z`) < GATE_START).sort();
    for (const h of await summarize(day, hours)) {
      if (!h) continue;
      failed += h.failed || 0;
      for (const v of h.pre || []) prestart.add(v);
    }
  }
  const total = newSummary('', '');
  for (const d of perDay) mergeSummary(total, d);

  const emails = await eventRows(events, days, 'email', deadline);
  const answers = await eventRows(events, days, 'answer', deadline);
  const partial = pending.length > 0 || failed > 0 || emails.failed + emails.skipped + answers.failed + answers.skipped > 0;

  const out = {
    generated: new Date().toISOString(),
    from: days[0] || null,
    to: days[days.length - 1] || null,
    partial,
    pending,
    days: perDay.map((d) => finalizeDay(d, prestart)),
    total: finalizeDay(total, prestart),
    emails: emails.rows.map((r) => pick(r, EMAIL_COLUMNS)),
    answers: answers.rows.map((r) => pick(r, ANSWER_COLUMNS))
  };

  if (format === 'csv') return csv(summaryRows(out), SUMMARY_COLUMNS, 'restline-summary.csv', partial);
  return json(out, 200, noStore());
}

async function hourSummary(events, summaries, day, hour) {
  const cacheKey = `${day}/${hour}`;
  const hourStart = Date.parse(`${day}T${hour}:00:00Z`);
  const closed = Number.isFinite(hourStart) && Date.now() > hourStart + 3600 * 1000 + HOUR_GRACE_MS;
  if (closed) {
    const cached = await summaries.get(cacheKey, { type: 'json' }).catch(() => null);
    if (cached && cached.v === SUMMARY_VERSION && cached.gs === GATE_START) return cached; // a new GATE_START rebuilds the caches
  }
  const keys = await listKeys(events, `${day}/${hour}/`);
  const read = await readRows(events, keys, Infinity);
  const s = newSummary(day, hour);
  for (const row of read.rows) addRow(s, row);
  s.failed = read.failed;
  if (closed && read.failed === 0) await summaries.setJSON(cacheKey, s).catch(() => {});
  return s;
}

// Rows of one event type across days, read straight from the events store (the key names the event).
async function eventRows(events, days, want, deadline) {
  const keys = [];
  for (const day of days) {
    for (const k of await listKeys(events, `${day}/`)) {
      const ev = keyEvent(k);
      if (ev === want || ev === null) keys.push(k);
    }
  }
  const read = await readRows(events, keys, deadline);
  read.rows = read.rows.filter((r) => r.event === want);
  read.rows.sort(byReceived);
  return read;
}

function keyEvent(key) {
  const m = /-([a-z]+)$/.exec(key);
  return m && EVENTS.has(m[1]) ? m[1] : null;
}

/* ---------------- summaries ---------------- */

function newSummary(day, hour) {
  return { v: SUMMARY_VERSION, gs: GATE_START, day, hour, rows: 0, failed: 0, pre: [], buckets: Object.create(null) };
}

// buckets are keyed by flag|source; leave maps vid -> largest seconds seen (one beacon per hide, cumulative).
// A gate bucket also splits its rows by creative under content["c:" + utm_content] ("c:none" when empty),
// each entry having the same shape as the bucket's own counts. pre lists the vids with a gate pageview
// received before GATE_START.

function newCounts() {
  return {
    pv: [], tap: [], email: [], answer: [], seen: [],
    n_pv: 0, n_tap: 0, n_tap_card: 0, n_tap_bar: 0, n_email: 0, n_answer: 0,
    video_playing: 0, video_blocked: 0, leave: {},
    device: { ios: 0, android: 0, other: 0 },
    inapp: { tiktok: 0, instagram: 0, facebook: 0, none: 0 }
  };
}

function newBucket() {
  return { ...newCounts(), bots: [], content: {} };
}

function contentKey(row) {
  return 'c:' + (row.utm_content || 'none');
}

function bucketKey(row) {
  const flag = row.flag || flagOf(row);
  const source = flag === 'no_utm' ? '' : String(row.utm_source || '');
  return `${flag}|${encodeSafe(source)}`;
}

function encodeSafe(s) {
  try { return encodeURIComponent(s); } catch { return encodeURIComponent(s.replace(/[\uD800-\uDFFF]/g, '\uFFFD')); }
}

function splitBucketKey(key) {
  const i = key.indexOf('|');
  let source = key.slice(i + 1);
  try { source = decodeURIComponent(source); } catch { /* keep as is */ }
  return [key.slice(0, i), source];
}

function addRow(s, row) {
  s.rows += 1;
  const key = bucketKey(row);
  const b = s.buckets[key] || (s.buckets[key] = newBucket());
  addCounts(b, row);
  if (row.event === 'pageview' && isBotPageview(row)) pushUnique(b.bots, row.vid);
  if ((row.flag || flagOf(row)) === 'gate') {
    const ck = contentKey(row);
    addCounts(b.content[ck] || (b.content[ck] = newCounts()), row);
    if (row.event === 'pageview' && Date.parse(row.received) < GATE_START) pushUnique(s.pre, row.vid);
  }
}

function addCounts(b, row) {
  switch (row.event) {
    case 'pageview':
      pushUnique(b.pv, row.vid); b.n_pv += 1;
      if (b.device[row.device] !== undefined) b.device[row.device] += 1;
      if (b.inapp[row.inapp] !== undefined) b.inapp[row.inapp] += 1;
      break;
    case 'tap':
      pushUnique(b.tap, row.vid); b.n_tap += 1;
      if (row.button === 'card') b.n_tap_card += 1; else if (row.button === 'bar') b.n_tap_bar += 1;
      break;
    case 'email':
      pushUnique(b.email, row.vid); b.n_email += 1;
      break;
    case 'answer':
      pushUnique(b.answer, row.vid); b.n_answer += 1;
      break;
    case 'video':
      if (row.video === 'playing') b.video_playing += 1; else b.video_blocked += 1;
      break;
    case 'seen':
      pushUnique(b.seen, row.vid);
      break;
    case 'leave': {
      const sec = Number(row.seconds) || 0;
      if (row.vid && !(b.leave[row.vid] >= sec)) b.leave[row.vid] = sec;
      break;
    }
    default:
      break;
  }
}

function isBotPageview(row) {
  return row.wd === true || row.scr === '0x0' || BOT_UA.test(row.ua || '');
}

function mergeCounts(a, b) {
  for (const set of ['pv', 'tap', 'email', 'answer', 'seen']) for (const v of b[set] || []) pushUnique(a[set], v);
  for (const n of ['n_pv', 'n_tap', 'n_tap_card', 'n_tap_bar', 'n_email', 'n_answer', 'video_playing', 'video_blocked']) a[n] += b[n] || 0;
  for (const vid of Object.keys(b.leave || {})) if (!(a.leave[vid] >= b.leave[vid])) a.leave[vid] = b.leave[vid];
  for (const k of Object.keys(a.device)) a.device[k] += (b.device && b.device[k]) || 0;
  for (const k of Object.keys(a.inapp)) a.inapp[k] += (b.inapp && b.inapp[k]) || 0;
}

function mergeBucket(a, b) {
  mergeCounts(a, b);
  for (const v of b.bots || []) pushUnique(a.bots, v);
  for (const ck of Object.keys(b.content || {})) mergeCounts(a.content[ck] || (a.content[ck] = newCounts()), b.content[ck]);
}

function mergeSummary(target, s) {
  if (!s) return;
  target.rows += s.rows || 0;
  target.failed += s.failed || 0;
  for (const v of s.pre || []) pushUnique(target.pre, v);
  for (const key of Object.keys(s.buckets || {})) {
    if (!target.buckets[key]) target.buckets[key] = newBucket();
    mergeBucket(target.buckets[key], s.buckets[key]);
  }
}

function finalizeBucket(b) {
  const uniques = new Set([...b.pv, ...b.tap, ...b.email, ...b.answer]).size;
  return {
    uniques,
    taps: b.tap.length,
    emails: b.email.length,
    answers: b.answer.length,
    tap_rate: uniques ? Number((b.tap.length / uniques).toFixed(4)) : 0,
    pageviews: b.n_pv,
    tap_events: b.n_tap,
    tap_events_card: b.n_tap_card,
    tap_events_bar: b.n_tap_bar,
    email_events: b.n_email,
    answer_events: b.n_answer,
    seen: b.seen.length,
    video: { playing: b.video_playing, blocked: b.video_blocked },
    leave: leaveStats(b.leave),
    device: { ...b.device },
    inapp: { ...b.inapp }
  };
}

function finalizeSource(b) {
  const content = Object.create(null);
  for (const ck of Object.keys(b.content || {}).sort()) content[ck.slice(2)] = finalizeBucket(b.content[ck]);
  return { ...finalizeBucket(b), content };
}

function leaveStats(map) {
  const values = Object.values(map || {});
  const sum = values.reduce((t, v) => t + v, 0);
  return { n: values.length, avg_seconds: values.length ? Math.round(sum / values.length) : 0 };
}

// Flags are decided per visitor, not per row, in the order bot > smoke > prestart > gate > no_utm: first
// every vid whose pageview carried bot evidence goes to the bot bucket with all its rows; a vid with a
// smoke pageview is smoke; every other vid in `prestart` (a gate pageview received before GATE_START,
// on any day) leaves every gate and no_utm bucket and every creative for the prestart bucket, with all
// its rows, rows after the start included; then a smoke vid is pulled out of every other bucket, gate
// buckets included; a vid with a gate pageview keeps that source for its no_utm rows (gate buckets keep
// each other's vids); a no_utm vid with no home stays. Unique-vid lists and the per-vid leave map move;
// per-row event counts stay where the rows were stored.
function resolveVisitors(original, prestart) {
  const buckets = Object.create(null);
  for (const key of Object.keys(original)) buckets[key] = JSON.parse(JSON.stringify(original[key]));
  const keys = Object.keys(buckets).sort();
  const flagOfKey = (key) => splitBucketKey(key)[0];

  const bot = newBucket();
  const botVids = new Set();
  for (const key of keys) for (const v of buckets[key].bots || []) botVids.add(v);
  if (botVids.size) for (const key of keys) moveVids(buckets[key], bot, botVids);

  const smokeVids = new Set();
  for (const key of keys) if (flagOfKey(key) === 'smoke') for (const v of buckets[key].pv) smokeVids.add(v);
  const pre = newBucket();
  const preVids = new Set();
  for (const v of prestart || []) if (!botVids.has(v) && !smokeVids.has(v)) preVids.add(v);
  if (preVids.size) {
    for (const key of keys) {
      const flag = flagOfKey(key);
      if (flag === 'gate' || flag === 'no_utm') moveVids(buckets[key], pre, preVids);
    }
  }

  const home = Object.create(null); // vid -> bucket key it belongs to; smoke pageviews first, then gate
  for (const key of keys) if (flagOfKey(key) === 'smoke') for (const v of buckets[key].pv) if (!home[v]) home[v] = key;
  for (const key of keys) if (flagOfKey(key) === 'gate') for (const v of buckets[key].pv) if (!home[v]) home[v] = key;
  const moves = (flag, target) => {
    if (!target) return false;
    const targetFlag = flagOfKey(target);
    if (targetFlag === 'smoke') return true;            // smoke pulls from every other bucket
    return targetFlag === 'gate' && flag === 'no_utm';  // gate pulls from no_utm only
  };
  for (const key of keys) {
    const flag = flagOfKey(key);
    const b = buckets[key];
    const byTarget = new Map();
    const consider = (v) => {
      const target = home[v];
      if (!target || target === key || !moves(flag, target)) return;
      if (!byTarget.has(target)) byTarget.set(target, new Set());
      byTarget.get(target).add(v);
    };
    for (const set of ['pv', 'tap', 'email', 'answer', 'seen']) for (const v of b[set]) consider(v);
    for (const v of Object.keys(b.leave || {})) consider(v);
    for (const [target, vids] of byTarget) {
      const t = buckets[target];
      // into a gate bucket (from no_utm): the untagged rows join the creative of the visitor's gate pageview;
      // with more than one, the first creative in alphabetical order
      const pick = flagOfKey(target) === 'gate' ? (v) => homeCreative(t, v) : null;
      moveVids(b, t, vids, pick);
    }
  }
  return { buckets, bot, prestart: pre };
}

function homeCreative(bucket, vid) {
  for (const ck of Object.keys(bucket.content || {}).sort()) if (bucket.content[ck].pv.includes(vid)) return ck;
  return 'c:none';
}

// Moves vids from one bucket to another: top-level lists and the leave map go to `to`; their entries in
// `from`'s creatives are dropped; when `pick` is given (a gate target) they also join to.content[pick(vid)].
function moveVids(from, to, vids, pick) {
  const sub = (v) => {
    const ck = pick(v);
    return to.content[ck] || (to.content[ck] = newCounts());
  };
  for (const set of ['pv', 'tap', 'email', 'answer', 'seen', 'bots']) {
    const keep = [];
    for (const v of from[set] || []) {
      if (!vids.has(v)) { keep.push(v); continue; }
      pushUnique(to[set], v);
      if (pick && set !== 'bots') pushUnique(sub(v)[set], v);
    }
    from[set] = keep;
  }
  for (const v of Object.keys(from.leave || {})) {
    if (!vids.has(v)) continue;
    if (!(to.leave[v] >= from.leave[v])) to.leave[v] = from.leave[v];
    if (pick) { const c = sub(v); if (!(c.leave[v] >= from.leave[v])) c.leave[v] = from.leave[v]; }
    delete from.leave[v];
  }
  for (const ck of Object.keys(from.content || {})) {
    const c = from.content[ck];
    for (const set of ['pv', 'tap', 'email', 'answer', 'seen']) c[set] = c[set].filter((v) => !vids.has(v));
    for (const v of Object.keys(c.leave || {})) if (vids.has(v)) delete c.leave[v];
  }
}

function finalizeDay(s, prestart) {
  const sources = Object.create(null);
  const blended = newBucket();
  const smoke = newBucket();
  const noUtm = newBucket();
  const { buckets, bot, prestart: pre } = resolveVisitors(s.buckets, prestart);
  for (const key of Object.keys(buckets)) {
    const b = buckets[key];
    const [flag, source] = splitBucketKey(key);
    if (flag === 'gate') {
      sources[source] = finalizeSource(b);
      mergeBucket(blended, b);
    } else if (flag === 'smoke') {
      mergeBucket(smoke, b);
    } else {
      mergeBucket(noUtm, b);
    }
  }
  return {
    day: s.day || 'all',
    rows: s.rows,
    sources,
    blended: finalizeBucket(blended),
    excluded: { smoke: finalizeBucket(smoke), no_utm: finalizeBucket(noUtm), bot: finalizeBucket(bot), prestart: finalizeBucket(pre) }
  };
}

/* ---------------- CSV ---------------- */

const RAW_COLUMNS = ['received', 'event', 'vid', 'flag', 'ts', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'device', 'inapp', 'ref', 'button', 'email', 'answer', 'video', 'seconds', 'ua', 'wd', 'scr'];
const EMAIL_COLUMNS = ['received', 'email', 'vid', 'flag', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'device', 'inapp'];
const ANSWER_COLUMNS = ['received', 'answer', 'vid', 'flag', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'device', 'inapp'];
const SUMMARY_COLUMNS = ['day', 'scope', 'source', 'content', 'uniques', 'taps', 'emails', 'answers', 'tap_rate', 'pageviews', 'tap_events', 'tap_events_card', 'tap_events_bar', 'seen', 'video_playing', 'video_blocked', 'leave_n', 'leave_avg_seconds', 'ios', 'android', 'other', 'inapp_tiktok', 'inapp_instagram', 'inapp_facebook', 'inapp_none'];

function summaryRows(out) {
  const rows = [];
  const flat = (day, scope, source, content, f) => rows.push({
    day, scope, source, content,
    uniques: f.uniques, taps: f.taps, emails: f.emails, answers: f.answers, tap_rate: f.tap_rate,
    pageviews: f.pageviews, tap_events: f.tap_events, tap_events_card: f.tap_events_card, tap_events_bar: f.tap_events_bar,
    seen: f.seen, video_playing: f.video.playing, video_blocked: f.video.blocked,
    leave_n: f.leave.n, leave_avg_seconds: f.leave.avg_seconds,
    ios: f.device.ios, android: f.device.android, other: f.device.other,
    inapp_tiktok: f.inapp.tiktok, inapp_instagram: f.inapp.instagram, inapp_facebook: f.inapp.facebook, inapp_none: f.inapp.none
  });
  for (const d of [...out.days, out.total]) {
    for (const source of Object.keys(d.sources)) {
      flat(d.day, 'gate', source, '', d.sources[source]);
      for (const c of Object.keys(d.sources[source].content)) flat(d.day, 'gate', source, c, d.sources[source].content[c]);
    }
    flat(d.day, 'gate', 'blended', '', d.blended);
    flat(d.day, 'excluded', 'smoke', '', d.excluded.smoke);
    flat(d.day, 'excluded', 'no_utm', '', d.excluded.no_utm);
    flat(d.day, 'excluded', 'bot', '', d.excluded.bot);
    flat(d.day, 'excluded', 'prestart', '', d.excluded.prestart);
  }
  return rows;
}

function csv(rows, columns, filename, partial) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(','));
  return new Response(lines.join('\r\n') + '\r\n', {
    status: 200,
    headers: {
      ...noStore(),
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Partial': partial ? 'true' : 'false'
    }
  });
}

function cell(value) {
  if (value === undefined || value === null) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ---------------- helpers ---------------- */

async function listDirs(store, prefix) {
  const res = await store.list({ prefix, directories: true });
  return (res.directories || []).map((d) => d.slice(prefix.length).replace(/\/$/, '')).filter(Boolean);
}

async function listKeys(store, prefix) {
  const res = await store.list({ prefix });
  return (res.blobs || []).map((b) => b.key);
}

// Reads rows with bounded concurrency, one retry per key, and a deadline; reports what it could not read.
async function readRows(store, keys, deadline) {
  const out = { rows: [], failed: 0, skipped: 0 };
  await mapLimit(keys, READ_CONCURRENCY, async (key) => {
    if (Date.now() > deadline) { out.skipped += 1; return; }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const row = await store.get(key, { type: 'json' });
        if (row && typeof row === 'object') out.rows.push(row);
        return;
      } catch (err) {
        if (attempt === 1) { console.error('read failed', key, err); out.failed += 1; }
      }
    }
  });
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (err) { console.error(err); out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

function byReceived(a, b) { return a.received < b.received ? -1 : a.received > b.received ? 1 : 0; }

function pushUnique(arr, v) { if (v && !arr.includes(v)) arr.push(v); }

function pick(row, columns) {
  const o = {};
  for (const c of columns) if (row[c] !== undefined) o[c] = row[c];
  return o;
}

function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }

function clean(v, max) {
  if (typeof v !== 'string') return '';
  // control characters become spaces; lone surrogates (invalid UTF-16) become U+FFFD so the value is always encodable
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, (m, lead) => (lead || '') + '\uFFFD')
    .trim().slice(0, max);
}

function refOrigin(v) {
  if (typeof v !== 'string' || !v) return '';
  try {
    const o = new URL(v).origin;
    return o === 'null' ? '' : o.slice(0, 200);
  } catch { return ''; }
}

function validTs(v) {
  if (typeof v !== 'string' || v.length > 40) return '';
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

function looksLikeEmail(v) {
  return typeof v === 'string' && v.length >= 3 && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function dayParam(v) { return typeof v === 'string' && DAY_RE.test(v) ? v : ''; }

function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function noStore() {
  return { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...noStore(), ...extra }
  });
}
