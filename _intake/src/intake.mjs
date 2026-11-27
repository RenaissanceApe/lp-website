/* The form front door's request and cron logic (entry point: worker.mjs). Receives the site's form POSTs, stores each one in D1,
 * redirects the visitor, then forwards the unchanged body to n8n. A cron run
 * every minute retries anything n8n has not confirmed, tells the owner on
 * Telegram once when submissions have waited too long, and deletes stored
 * copies a fixed number of days after n8n confirmed them.
 *
 * How it works and how to run it: _docs/FORM_FRONT_DOOR.md. Contract: INTAKE.md.
 *
 * Settings (Worker → Settings → Variables and Secrets):
 *   N8N_WEBHOOK_URL     where n8n's inbound-lead webhook is (required to forward)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   for the stalled / cleared / lost messages
 *   INTAKE_SECRET       optional; sent as X-LP-Intake-Secret when present
 *   SITE_ORIGIN, ALERT_AFTER_MINUTES, RETENTION_DAYS   optional overrides
 * Binding: DB (the D1 database, created in the EU jurisdiction).
 */
import {
  assess, setting, absolute, forwardHeaders, isDelivered, failurePage,
  alertText, clearedText, lostText,
} from './logic.mjs';

const nowIso = () => new Date().toISOString();
const ago = ms => new Date(Date.now() - ms).toISOString();

/* A row may be (re)tried when nobody has touched it for this long. Every attempt
   finishes within the 10 s forward timeout, so 50 s leaves a wide margin and stops
   two cron runs, or a cron run and the first attempt, sending the same row twice. */
const CLAIM_MS = 50_000;

export function redirect(env, path) {
  return new Response(null, { status: 303, headers: { Location: absolute(setting(env, 'SITE_ORIGIN'), path) } });
}

/* One POST to n8n. Returns { ok, result } and never throws. */
export async function forward(env, row) {
  const url = env.N8N_WEBHOOK_URL;
  if (!url) return { ok: false, result: 'no N8N_WEBHOOK_URL set', reachable: false };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: forwardHeaders(row, env),
      body: row.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(setting(env, 'FORWARD_TIMEOUT_MS')),
    });
    return { ok: isDelivered(res.status), result: `HTTP ${res.status}`, reachable: true };
  } catch (e) {
    return { ok: false, result: String((e && e.name) || 'error'), reachable: false };
  }
}

async function attempt(env, row) {
  const r = await forward(env, row);
  const at = nowIso();
  await env.DB.prepare(
    'UPDATE submissions SET attempts = attempts + 1, last_result = ?, forwarded_at = ? WHERE id = ?'
  ).bind(r.result, r.ok ? at : null, row.id).run();
  return r;
}

export async function telegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function handlePost(request, env, ctx) {
  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  const body = await request.text();
  if (body.length > setting(env, 'MAX_BODY_BYTES')) {
    return new Response('Payload too large', { status: 413 });
  }
  const params = new URLSearchParams(type.startsWith('application/x-www-form-urlencoded') ? body : '');
  const verdict = assess(params);
  if (!verdict.ok) return redirect(env, verdict.redirect);

  const row = { id: crypto.randomUUID(), received_at: nowIso(), body, attempts: 0 };
  let stored = false;
  try {
    await env.DB.prepare(
      'INSERT INTO submissions (id, received_at, form_type, lang, body, last_attempt_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(row.id, row.received_at, verdict.formType, verdict.lang, body, row.received_at).run();
    stored = true;
  } catch (e) {
    console.error('intake: store failed', String((e && e.message) || e));
  }

  if (stored) {
    // The visitor is redirected now; the first delivery attempt runs after the response.
    ctx.waitUntil(attempt(env, row).catch(e => console.error('intake: first attempt', String(e))));
    return redirect(env, verdict.redirect);
  }

  // Storage failed: try n8n directly while the visitor waits (at most the forward timeout).
  const direct = await forward(env, row);
  if (direct.ok) return redirect(env, verdict.redirect);
  ctx.waitUntil(telegram(env, lostText(row.received_at)));
  return new Response(failurePage(params, env), {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/* The cron run: retry, alert, purge. */
export async function runScheduled(env) {
  // 1. Retry pending rows, oldest first. Stop the batch as soon as n8n is unreachable:
  //    one probe a minute is enough while it is down.
  const { results } = await env.DB.prepare(
    'SELECT id, received_at, body, attempts FROM submissions WHERE forwarded_at IS NULL AND last_attempt_at < ? ORDER BY received_at LIMIT ?'
  ).bind(ago(CLAIM_MS), setting(env, 'BATCH')).all();
  for (const row of results) {
    const claim = await env.DB.prepare(
      'UPDATE submissions SET last_attempt_at = ? WHERE id = ? AND forwarded_at IS NULL AND last_attempt_at < ?'
    ).bind(nowIso(), row.id, ago(CLAIM_MS)).run();
    if (!claim.meta || claim.meta.changes !== 1) continue;
    const r = await attempt(env, row);
    if (!r.reachable) break;
  }

  // 2. One Telegram message per incident, and one when it clears.
  const pending = await env.DB.prepare(
    'SELECT COUNT(*) AS n, MIN(received_at) AS oldest FROM submissions WHERE forwarded_at IS NULL'
  ).first();
  const open = await env.DB.prepare("SELECT value FROM state WHERE key = 'alert_open'").first();
  const waitMs = setting(env, 'ALERT_AFTER_MINUTES') * 60_000;
  if (pending.n > 0 && !open && pending.oldest < ago(waitMs)) {
    if (await telegram(env, alertText(pending.n, pending.oldest))) {
      await env.DB.prepare("INSERT OR REPLACE INTO state (key, value) VALUES ('alert_open', ?)").bind(nowIso()).run();
    }
  } else if (pending.n === 0 && open) {
    await telegram(env, clearedText(nowIso()));
    await env.DB.prepare("DELETE FROM state WHERE key = 'alert_open'").run();
  }

  // 3. Retention: delete stored copies n8n confirmed more than RETENTION_DAYS ago.
  await env.DB.prepare(
    'DELETE FROM submissions WHERE forwarded_at IS NOT NULL AND forwarded_at < ?'
  ).bind(ago(setting(env, 'RETENTION_DAYS') * 86_400_000)).run();
}
