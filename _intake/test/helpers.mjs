/* Test doubles: a D1-shaped wrapper over node:sqlite (so the real schema.sql and the
 * real SQL in worker.mjs run), a fake fetch for n8n and Telegram, and a ctx that
 * collects waitUntil promises. */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function makeDB() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(import.meta.dirname, '..', 'schema.sql'), 'utf8'));
  const d1 = {
    raw: db,
    failWrites: false,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async run() {
          if (d1.failWrites) throw new Error('D1 unavailable');
          const r = db.prepare(sql).run(...args);
          return { meta: { changes: Number(r.changes) } };
        },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
      };
      return stmt;
    },
  };
  return d1;
}

export function makeCtx() {
  const pending = [];
  return { waitUntil: p => pending.push(p), settle: () => Promise.all(pending.splice(0)) };
}

/* n8n behaviour: 'up' (303), 'down' (network error), or a status number. */
export function installFetch() {
  const calls = { n8n: [], telegram: [] };
  const state = { n8n: 'up' };
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
      calls.telegram.push(JSON.parse(init.body).text);
      return new Response('{}', { status: 200 });
    }
    calls.n8n.push({ url, headers: init.headers, body: init.body, redirect: init.redirect });
    if (state.n8n === 'down') throw new TypeError('fetch failed');
    const status = state.n8n === 'up' ? 303 : state.n8n;
    return new Response(null, { status, headers: status === 303 ? { Location: '/thank-you.html' } : {} });
  };
  return { calls, state };
}

export const ENV = db => ({
  DB: db,
  N8N_WEBHOOK_URL: 'https://n8n.example/webhook/inbound-lead',
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_CHAT_ID: '1',
});

export function post(fields, url = 'https://www.lumenandpixel.com/intake') {
  const body = new URLSearchParams(fields).toString();
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

export const CONTACT_EN = {
  form_type: 'contact', lang: 'en', source_page: '/about.html', quiz_result: '',
  name: 'Ana Test', company: '', email: 'ana@example.com', service: 'Show Design',
  message: 'Hello <b>there</b>', lp_ref_code: '',
};
export const NEWSLETTER_PT = {
  form_type: 'newsletter', lang: 'pt', source_page: '/pt/', email: 'rui@example.pt',
  consent: 'yes', lp_ref_code: '',
};

/* Make every stored row look older, to step time forward without waiting. */
export function age(db, minutes) {
  const shift = `-${minutes} minutes`;
  db.raw.exec(`UPDATE submissions SET
    received_at = strftime('%Y-%m-%dT%H:%M:%fZ', received_at, '${shift}'),
    last_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', last_attempt_at, '${shift}'),
    forwarded_at = CASE WHEN forwarded_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', forwarded_at, '${shift}') END`);
}
