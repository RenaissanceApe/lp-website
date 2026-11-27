import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, safePath, successPath, forwardHeaders, isDelivered, failurePage, alertText, setting } from '../src/logic.mjs';

const P = o => new URLSearchParams(o);

test('redirects match INTAKE.md', () => {
  assert.equal(successPath('contact', 'en'), '/thank-you.html');
  assert.equal(successPath('contact', 'pt'), '/pt/thank-you.html');
  assert.equal(successPath('newsletter', 'en'), '/check-your-inbox.html');
  assert.equal(successPath('newsletter', 'pt'), '/pt/check-your-inbox.html');
});

test('a good submission is accepted', () => {
  const v = assess(P({ form_type: 'newsletter', lang: 'pt', source_page: '/pt/', email: 'a@b.pt' }));
  assert.deepEqual(v, { ok: true, formType: 'newsletter', lang: 'pt', redirect: '/pt/check-your-inbox.html' });
});

test('an invalid email goes back to the source page, not stored', () => {
  for (const email of ['', 'nope', 'a@b', 'a b@c.pt', 'x'.repeat(250) + '@b.pt']) {
    const v = assess(P({ form_type: 'contact', lang: 'en', source_page: '/about.html', email }));
    assert.equal(v.ok, false, email);
    assert.equal(v.redirect, '/about.html');
  }
});

test('an unknown form_type is refused', () => {
  const v = assess(P({ form_type: 'quiz', lang: 'pt', source_page: '/pt/', email: 'a@b.pt' }));
  assert.equal(v.ok, false);
  assert.equal(v.redirect, '/pt/');
});

test('the honeypot is not screened here', () => {
  const v = assess(P({ form_type: 'contact', lang: 'en', email: 'a@b.pt', lp_ref_code: 'bot' }));
  assert.equal(v.ok, true);
});

test('source_page can never send the visitor to another host', () => {
  for (const bad of ['//evil.example/', 'https://evil.example/', '/\\evil.example', 'javascript:x', '', undefined, '/a b'])
    assert.equal(safePath(bad, 'en'), '/', String(bad));
  assert.equal(safePath('//evil', 'pt'), '/pt/');
  assert.equal(safePath('/pt/about.html', 'pt'), '/pt/about.html');
});

test('forward headers: id, time, attempt; secret only when set', () => {
  const row = { id: 'abc', received_at: '2026-11-30T10:00:00.000Z', attempts: 2 };
  const h = forwardHeaders(row, {});
  assert.equal(h['X-LP-Submission-Id'], 'abc');
  assert.equal(h['X-LP-Received-At'], row.received_at);
  assert.equal(h['X-LP-Attempt'], '3');
  assert.equal('X-LP-Intake-Secret' in h, false);
  assert.equal(forwardHeaders(row, { INTAKE_SECRET: 's' })['X-LP-Intake-Secret'], 's');
});

test('delivered = 2xx, or a 303 back to the site; any other 3xx is not', () => {
  for (const s of [200, 201, 204]) assert.equal(isDelivered(s, null), true, s);
  assert.equal(isDelivered(303, 'https://lumenandpixel.com/thank-you.html'), true);
  assert.equal(isDelivered(303, 'https://www.lumenandpixel.com/pt/check-your-inbox.html'), true);
  assert.equal(isDelivered(303, 'https://login.example.com/auth'), false, '303 to another host');
  assert.equal(isDelivered(302, 'https://login.example.com/auth'), false, '302 to another host');
  assert.equal(isDelivered(302, 'https://lumenandpixel.com/thank-you.html'), false, '302 even to the site');
  assert.equal(isDelivered(303, '/login'), false, 'relative Location');
  assert.equal(isDelivered(303, 'http://lumenandpixel.com/'), false, 'not https');
  assert.equal(isDelivered(303, 'https://lumenandpixel.com.evil.example/'), false, 'look-alike host');
  assert.equal(isDelivered(303, null), false, 'no Location');
  for (const s of [301, 307, 400, 401, 404, 500, 503]) assert.equal(isDelivered(s, 'https://lumenandpixel.com/'), false, s);
});

test('failure page: right language, escapes what the visitor typed, loads nothing', () => {
  const html = failurePage(P({ lang: 'pt', source_page: '/pt/about.html', message: '<script>x</script>' }), {});
  assert.match(html, /lang="pt-PT"/);
  assert.match(html, /não foi enviada/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<link|src=/);
  assert.match(html, /href="https:\/\/www\.lumenandpixel\.com\/pt\/about\.html"/);
});

test('alert text carries a count and a time only', () => {
  const t = alertText(3, '2026-11-30T10:05:00.000Z');
  assert.match(t, /3 submissions/);
  assert.match(t, /10:05/); // Lisbon is UTC+0 in winter
});

test('settings fall back to defaults', () => {
  assert.equal(setting({}, 'RETENTION_DAYS'), 7);
  assert.equal(setting({ RETENTION_DAYS: '3' }, 'RETENTION_DAYS'), 3);
});
