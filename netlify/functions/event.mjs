// One function, two routes (via netlify.toml rewrites):
//   POST /api/event            stores one raw row per event in Netlify Blobs (store "events", key day/hour/id)
//   GET  /admin?key=ADMIN_KEY  counts per day: uniques (by vid) per utm_source and blended, taps, emails, answers
//
// Rows are never deduped on write. Closed hours are summarised once and cached in the "summaries" store.
// Rows with utm_campaign=smoke and rows without utm_source are stored but kept out of the gate counts.

import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const EVENTS = new Set(['pageview', 'tap', 'email', 'answer', 'video', 'seen', 'leave']);
const DEVICES = new Set(['ios', 'android', 'other']);
const INAPPS = new Set(['tiktok', 'instagram', 'facebook', 'none']);
const VIDEO_STATES = new Set(['playing', 'blocked']);
const BUTTONS = new Set(['card', 'bar']);
const VID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 8192;
const COOKIE_MAX_AGE = 90 * 24 * 60 * 60;
const SUMMARY_VERSION = 1;
const HOUR_GRACE_MS = 2 * 60 * 1000;
const READ_CONCURRENCY = 24;
const HOUR_CONCURRENCY = 4;

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const isAdmin = path.endsWith('/admin') || (req.method === 'GET' && url.searchParams.has('key'));
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
    ref: clean(data.ref, 500).replace(/[?#][\s\S]*$/, '')
  };
  row.flag = flagOf(row);

  if (name === 'email') {
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
  const key = `${day}/${hour}/${now.getTime()}-${randomBytes(4).toString('hex')}`;
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

  const events = getStore({ name: 'events', consistency: 'strong' });
  const summaries = getStore({ name: 'summaries', consistency: 'strong' });

  const days = (await listDirs(events, '')).filter((d) => DAY_RE.test(d) && (!from || d >= from) && (!to || d <= to)).sort();

  if (table === 'raw') {
    if (!only) return json({ error: 'table=raw needs day=YYYY-MM-DD' }, 400);
    const keys = await listKeys(events, `${only}/`);
    const rows = (await mapLimit(keys, READ_CONCURRENCY, (k) => events.get(k, { type: 'json' }))).filter(Boolean);
    rows.sort((a, b) => (a.received < b.received ? -1 : a.received > b.received ? 1 : 0));
    if (format === 'csv') return csv(rows, RAW_COLUMNS, `restline-raw-${only}.csv`);
    return json({ day: only, rows }, 200, noStore());
  }

  const perDay = [];
  for (const day of days) {
    const hours = (await listDirs(events, `${day}/`)).sort();
    const hourSummaries = await mapLimit(hours, HOUR_CONCURRENCY, (hour) => hourSummary(events, summaries, day, hour));
    const merged = newSummary(day, '');
    for (const h of hourSummaries) mergeSummary(merged, h);
    perDay.push(merged);
  }
  const total = newSummary('', '');
  for (const d of perDay) mergeSummary(total, d);

  const out = {
    generated: new Date().toISOString(),
    from: days[0] || null,
    to: days[days.length - 1] || null,
    days: perDay.map(finalizeDay),
    total: finalizeDay(total),
    emails: perDay.flatMap((d) => d.emails),
    answers: perDay.flatMap((d) => d.answers)
  };

  if (table === 'emails') {
    return format === 'csv' ? csv(out.emails, EMAIL_COLUMNS, 'restline-emails.csv') : json({ generated: out.generated, emails: out.emails }, 200, noStore());
  }
  if (table === 'answers') {
    return format === 'csv' ? csv(out.answers, ANSWER_COLUMNS, 'restline-answers.csv') : json({ generated: out.generated, answers: out.answers }, 200, noStore());
  }
  if (format === 'csv') return csv(summaryRows(out), SUMMARY_COLUMNS, 'restline-summary.csv');
  return json(out, 200, noStore());
}

async function hourSummary(events, summaries, day, hour) {
  const cacheKey = `${day}/${hour}`;
  const hourStart = Date.parse(`${day}T${hour}:00:00Z`);
  const closed = Number.isFinite(hourStart) && Date.now() > hourStart + 3600 * 1000 + HOUR_GRACE_MS;
  if (closed) {
    const cached = await summaries.get(cacheKey, { type: 'json' }).catch(() => null);
    if (cached && cached.v === SUMMARY_VERSION) return cached;
  }
  const keys = await listKeys(events, `${day}/${hour}/`);
  const rows = (await mapLimit(keys, READ_CONCURRENCY, (k) => events.get(k, { type: 'json' }))).filter(Boolean);
  const s = newSummary(day, hour);
  for (const row of rows) addRow(s, row);
  if (closed) await summaries.setJSON(cacheKey, s).catch(() => {});
  return s;
}

/* ---------------- summaries ---------------- */

function newSummary(day, hour) {
  return { v: SUMMARY_VERSION, day, hour, rows: 0, buckets: {}, emails: [], answers: [] };
}

function newBucket() {
  return {
    pv: [], tap: [], email: [], answer: [], seen: [],
    n_pv: 0, n_tap: 0, n_tap_card: 0, n_tap_bar: 0, n_email: 0, n_answer: 0,
    video_playing: 0, video_blocked: 0, leave_n: 0, leave_seconds: 0,
    device: { ios: 0, android: 0, other: 0 },
    inapp: { tiktok: 0, instagram: 0, facebook: 0, none: 0 }
  };
}

function bucketKey(row) {
  const flag = row.flag || flagOf(row);
  return flag === 'gate' ? `gate|${row.utm_source}` : flag === 'smoke' ? `smoke|${row.utm_source || ''}` : 'no_utm|';
}

function addRow(s, row) {
  s.rows += 1;
  const key = bucketKey(row);
  const b = s.buckets[key] || (s.buckets[key] = newBucket());
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
      s.emails.push(pick(row, EMAIL_COLUMNS));
      break;
    case 'answer':
      pushUnique(b.answer, row.vid); b.n_answer += 1;
      s.answers.push(pick(row, ANSWER_COLUMNS));
      break;
    case 'video':
      if (row.video === 'playing') b.video_playing += 1; else b.video_blocked += 1;
      break;
    case 'seen':
      pushUnique(b.seen, row.vid);
      break;
    case 'leave':
      b.leave_n += 1; b.leave_seconds += Number(row.seconds) || 0;
      break;
    default:
      break;
  }
}

function mergeBucket(a, b) {
  for (const set of ['pv', 'tap', 'email', 'answer', 'seen']) for (const v of b[set]) pushUnique(a[set], v);
  for (const n of ['n_pv', 'n_tap', 'n_tap_card', 'n_tap_bar', 'n_email', 'n_answer', 'video_playing', 'video_blocked', 'leave_n', 'leave_seconds']) a[n] += b[n] || 0;
  for (const k of Object.keys(a.device)) a.device[k] += (b.device && b.device[k]) || 0;
  for (const k of Object.keys(a.inapp)) a.inapp[k] += (b.inapp && b.inapp[k]) || 0;
}

function mergeSummary(target, s) {
  if (!s) return;
  target.rows += s.rows;
  for (const [key, b] of Object.entries(s.buckets)) {
    if (!target.buckets[key]) target.buckets[key] = newBucket();
    mergeBucket(target.buckets[key], b);
  }
  target.emails.push(...s.emails);
  target.answers.push(...s.answers);
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
    leave: { n: b.leave_n, avg_seconds: b.leave_n ? Math.round(b.leave_seconds / b.leave_n) : 0 },
    device: { ...b.device },
    inapp: { ...b.inapp }
  };
}

function finalizeDay(s) {
  const sources = {};
  const blended = newBucket();
  const smoke = newBucket();
  const noUtm = newBucket();
  for (const [key, b] of Object.entries(s.buckets)) {
    const [flag, source] = key.split('|');
    if (flag === 'gate') {
      sources[source] = finalizeBucket(b);
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
    excluded: { smoke: finalizeBucket(smoke), no_utm: finalizeBucket(noUtm) }
  };
}

/* ---------------- CSV ---------------- */

const RAW_COLUMNS = ['received', 'event', 'vid', 'flag', 'ts', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'device', 'inapp', 'ref', 'button', 'email', 'answer', 'video', 'seconds'];
const EMAIL_COLUMNS = ['received', 'email', 'vid', 'flag', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'device', 'inapp'];
const ANSWER_COLUMNS = ['received', 'answer', 'vid', 'flag', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'device', 'inapp'];
const SUMMARY_COLUMNS = ['day', 'scope', 'source', 'uniques', 'taps', 'emails', 'answers', 'tap_rate', 'pageviews', 'tap_events', 'tap_events_card', 'tap_events_bar', 'seen', 'video_playing', 'video_blocked', 'leave_n', 'leave_avg_seconds', 'ios', 'android', 'other', 'inapp_tiktok', 'inapp_instagram', 'inapp_facebook', 'inapp_none'];

function summaryRows(out) {
  const rows = [];
  const flat = (day, scope, source, f) => rows.push({
    day, scope, source,
    uniques: f.uniques, taps: f.taps, emails: f.emails, answers: f.answers, tap_rate: f.tap_rate,
    pageviews: f.pageviews, tap_events: f.tap_events, tap_events_card: f.tap_events_card, tap_events_bar: f.tap_events_bar,
    seen: f.seen, video_playing: f.video.playing, video_blocked: f.video.blocked,
    leave_n: f.leave.n, leave_avg_seconds: f.leave.avg_seconds,
    ios: f.device.ios, android: f.device.android, other: f.device.other,
    inapp_tiktok: f.inapp.tiktok, inapp_instagram: f.inapp.instagram, inapp_facebook: f.inapp.facebook, inapp_none: f.inapp.none
  });
  for (const d of [...out.days, out.total]) {
    for (const [source, f] of Object.entries(d.sources)) flat(d.day, 'gate', source, f);
    flat(d.day, 'gate', 'blended', d.blended);
    flat(d.day, 'excluded', 'smoke', d.excluded.smoke);
    flat(d.day, 'excluded', 'no_utm', d.excluded.no_utm);
  }
  return rows;
}

function csv(rows, columns, filename) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c], c)).join(','));
  return new Response(lines.join('\r\n') + '\r\n', {
    status: 200,
    headers: {
      ...noStore(),
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  });
}

function cell(value, column) {
  if (value === undefined || value === null) return '';
  let s = String(value);
  if (column !== 'email' ? /^[=+\-@\t\r]/.test(s) : s.startsWith('=')) s = "'" + s;
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

function pushUnique(arr, v) { if (v && !arr.includes(v)) arr.push(v); }

function pick(row, columns) {
  const o = {};
  for (const c of columns) if (row[c] !== undefined) o[c] = row[c];
  return o;
}

function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }

function clean(v, max) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
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
