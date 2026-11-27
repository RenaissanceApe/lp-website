/* End to end through the real worker.mjs and schema.sql: post a form body, check the
 * redirect, the stored row, what reached n8n, retries, alerts and retention. */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { runScheduled } from '../src/intake.mjs';
import { makeDB, makeCtx, installFetch, ENV, post, CONTACT_EN, NEWSLETTER_PT, age } from './helpers.mjs';

let db, env, ctx, net;
beforeEach(() => { db = makeDB(); env = ENV(db); ctx = makeCtx(); net = installFetch(); });
const rows = () => db.raw.prepare('SELECT * FROM submissions').all();

test('contact (EN): 303 to thank-you, stored, forwarded unchanged with headers', async () => {
  const req = post(CONTACT_EN);
  const sent = new URLSearchParams(CONTACT_EN).toString();
  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), 'https://www.lumenandpixel.com/thank-you.html');
  await ctx.settle();
  const [r] = rows();
  assert.equal(r.form_type, 'contact');
  assert.equal(r.body, sent);
  assert.ok(r.forwarded_at);
  assert.equal(r.attempts, 1);
  assert.equal(r.last_result, 'HTTP 303');
  const call = net.calls.n8n[0];
  assert.equal(call.body, sent);
  assert.equal(call.redirect, 'manual');
  assert.equal(call.headers['X-LP-Submission-Id'], r.id);
  assert.equal(call.headers['X-LP-Attempt'], '1');
  assert.equal('X-LP-Intake-Secret' in call.headers, false);
});

test('newsletter (PT): 303 to /pt/check-your-inbox.html', async () => {
  const res = await worker.fetch(post(NEWSLETTER_PT), env, ctx);
  assert.equal(res.headers.get('Location'), 'https://www.lumenandpixel.com/pt/check-your-inbox.html');
});

test('honeypot filled: still stored and forwarded (n8n screens it)', async () => {
  await worker.fetch(post({ ...CONTACT_EN, lp_ref_code: 'spam' }), env, ctx);
  await ctx.settle();
  assert.match(net.calls.n8n[0].body, /lp_ref_code=spam/);
});

test('invalid email: back to the source page, nothing stored or sent', async () => {
  const res = await worker.fetch(post({ ...CONTACT_EN, email: 'not-an-email' }), env, ctx);
  assert.equal(res.headers.get('Location'), 'https://www.lumenandpixel.com/about.html');
  await ctx.settle();
  assert.equal(rows().length, 0);
  assert.equal(net.calls.n8n.length, 0);
});

test('secret header is added only when INTAKE_SECRET is set', async () => {
  env.INTAKE_SECRET = 'shh';
  await worker.fetch(post(CONTACT_EN), env, ctx);
  await ctx.settle();
  assert.equal(net.calls.n8n[0].headers['X-LP-Intake-Secret'], 'shh');
});

test('GET goes to the home page', async () => {
  const res = await worker.fetch(new Request('https://www.lumenandpixel.com/intake'), env, ctx);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), 'https://www.lumenandpixel.com/');
});

test('oversized body is refused', async () => {
  const res = await worker.fetch(post({ ...CONTACT_EN, message: 'x'.repeat(40000) }), env, ctx);
  assert.equal(res.status, 413);
});

test('n8n down for 12 minutes: visitor still redirected, one alert, delivered once back, cleared', async () => {
  net.state.n8n = 'down';
  const res = await worker.fetch(post(CONTACT_EN), env, ctx);
  assert.equal(res.status, 303);
  await ctx.settle();
  assert.equal(rows()[0].forwarded_at, null);

  // Cron runs while down: retries, no alert before 10 minutes.
  for (let m = 1; m <= 9; m++) { age(db, 1); await runScheduled(env); }
  assert.equal(net.calls.telegram.length, 0);
  // Past 10 minutes: exactly one alert, however many ticks follow.
  for (let m = 10; m <= 12; m++) { age(db, 1); await runScheduled(env); }
  assert.equal(net.calls.telegram.length, 1);
  assert.match(net.calls.telegram[0], /1 submission waiting/);
  assert.doesNotMatch(net.calls.telegram[0], /Ana|example\.com|Hello/);

  // n8n back: delivered on the next tick, then one "cleared" message.
  net.state.n8n = 'up';
  age(db, 1); await runScheduled(env);
  const r = rows()[0];
  assert.ok(r.forwarded_at);
  assert.ok(r.attempts >= 2);
  assert.equal(net.calls.telegram.length, 2);
  assert.match(net.calls.telegram[1], /cleared/);
  // Same id on every attempt, for de-duplication in n8n.
  assert.equal(new Set(net.calls.n8n.map(c => c.headers['X-LP-Submission-Id'])).size, 1);
  age(db, 1); await runScheduled(env);
  assert.equal(net.calls.telegram.length, 2);
});

test('n8n answers 500: kept and retried; batch carries on past an HTTP error', async () => {
  net.state.n8n = 500;
  await worker.fetch(post(CONTACT_EN), env, ctx);
  await worker.fetch(post(NEWSLETTER_PT), env, ctx);
  await ctx.settle();
  age(db, 1);
  net.calls.n8n.length = 0;
  await runScheduled(env);
  assert.equal(net.calls.n8n.length, 2);
  assert.ok(rows().every(r => r.forwarded_at === null && r.last_result === 'HTTP 500'));
});

test('n8n unreachable: one probe per run, not one per row', async () => {
  net.state.n8n = 'down';
  for (let i = 0; i < 5; i++) await worker.fetch(post(CONTACT_EN), env, ctx);
  await ctx.settle();
  age(db, 1);
  net.calls.n8n.length = 0;
  await runScheduled(env);
  assert.equal(net.calls.n8n.length, 1);
});

test('a row is not retried while its first attempt may still be running', async () => {
  net.state.n8n = 'down';
  await worker.fetch(post(CONTACT_EN), env, ctx);
  await ctx.settle();
  net.calls.n8n.length = 0;
  await runScheduled(env); // same minute: the claim is fresh
  assert.equal(net.calls.n8n.length, 0);
});

test('no N8N_WEBHOOK_URL yet: stored and kept until it is set', async () => {
  delete env.N8N_WEBHOOK_URL;
  const res = await worker.fetch(post(CONTACT_EN), env, ctx);
  assert.equal(res.status, 303);
  await ctx.settle();
  assert.equal(rows()[0].last_result, 'no N8N_WEBHOOK_URL set');
  env.N8N_WEBHOOK_URL = 'https://n8n.example/webhook/inbound-lead';
  age(db, 1); await runScheduled(env);
  assert.ok(rows()[0].forwarded_at);
});

test('storage down, n8n up: forwarded directly, visitor redirected as normal', async () => {
  db.failWrites = true;
  const res = await worker.fetch(post(CONTACT_EN), env, ctx);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), 'https://www.lumenandpixel.com/thank-you.html');
  assert.equal(net.calls.n8n.length, 1);
});

test('storage down and n8n down: error page in the visitor language, owner told', async () => {
  db.failWrites = true;
  net.state.n8n = 'down';
  const res = await worker.fetch(post({ ...NEWSLETTER_PT }), env, ctx);
  assert.equal(res.status, 503);
  const html = await res.text();
  assert.match(html, /não foi enviada/);
  assert.match(html, /info@lumenandpixel\.com/);
  await ctx.settle();
  assert.equal(net.calls.telegram.length, 1);
  assert.match(net.calls.telegram[0], /could NOT be stored or delivered/);
  assert.doesNotMatch(net.calls.telegram[0], /rui@/);
});

test('retention: deleted 7 days after n8n confirmed, not before; unconfirmed never', async () => {
  await worker.fetch(post(CONTACT_EN), env, ctx);
  await ctx.settle();
  net.state.n8n = 'down';
  await worker.fetch(post(NEWSLETTER_PT), env, ctx);
  await ctx.settle();
  age(db, 6 * 24 * 60);
  await runScheduled(env);
  assert.equal(rows().length, 2);
  age(db, 2 * 24 * 60);
  await runScheduled(env);
  const left = rows();
  assert.equal(left.length, 1);
  assert.equal(left[0].form_type, 'newsletter');
  assert.equal(left[0].forwarded_at, null);
});
