/* Pure logic for the form front door: no Cloudflare APIs here, so node:test
 * can cover all of it. The contract this implements is INTAKE.md.
 */

export const DEFAULTS = {
  SITE_ORIGIN: 'https://www.lumenandpixel.com',
  ALERT_AFTER_MINUTES: 10,   // Telegram once submissions have waited this long
  RETENTION_DAYS: 7,         // stored copy deleted this long after n8n confirmed it
  FORWARD_TIMEOUT_MS: 10000,
  MAX_BODY_BYTES: 32768,     // the contact form's largest real body is about 13 KB
  BATCH: 20,                 // rows retried per cron run (subrequest limit is 50)
  STUDIO_EMAIL: 'info@lumenandpixel.com',
};

export function setting(env, key) {
  const v = env && env[key];
  if (v === undefined || v === null || v === '') return DEFAULTS[key];
  return typeof DEFAULTS[key] === 'number' ? Number(v) : String(v);
}

const FORM_TYPES = new Set(['contact', 'newsletter']);

/* Same test the browser applies to type="email", close enough: something@something.tld,
   no spaces, at most 254 characters. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* A path on the site, never another host: starts with one slash, no backslash,
   no scheme. Anything else falls back to the home page of the language. */
export function safePath(p, lang) {
  if (typeof p === 'string' && /^\/(?![/\\])[A-Za-z0-9\-._~/]*$/.test(p)) return p;
  return lang === 'pt' ? '/pt/' : '/';
}

export const langOf = params => (params.get('lang') === 'pt' ? 'pt' : 'en');

/* Where the visitor goes after a good submission (INTAKE.md, "Response"). */
export function successPath(formType, lang) {
  const page = formType === 'newsletter' ? '/check-your-inbox.html' : '/thank-you.html';
  return (lang === 'pt' ? '/pt' : '') + page;
}

/* Decide what to do with a posted body. Returns
 *   { ok: true,  formType, lang, redirect }  → store, forward, send visitor to redirect
 *   { ok: false, reason, lang, redirect }    → not stored; send visitor to redirect
 * The honeypot is deliberately NOT looked at: n8n screens it (INTAKE.md).
 */
export function assess(params) {
  const lang = langOf(params);
  const back = safePath(params.get('source_page'), lang);
  const formType = params.get('form_type') || '';
  if (!FORM_TYPES.has(formType)) return { ok: false, reason: 'form_type', lang, redirect: back };
  const email = (params.get('email') || '').trim();
  if (email.length > 254 || !EMAIL.test(email)) return { ok: false, reason: 'email', lang, redirect: back };
  return { ok: true, formType, lang, redirect: successPath(formType, lang) };
}

export const absolute = (origin, path) => origin.replace(/\/+$/, '') + path;

/* Headers sent to n8n with the unchanged body. The secret header only exists when the
   INTAKE_SECRET setting does. */
export function forwardHeaders(row, env) {
  const h = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-LP-Submission-Id': row.id,
    'X-LP-Received-At': row.received_at,
    'X-LP-Attempt': String(row.attempts + 1),
  };
  if (env && env.INTAKE_SECRET) h['X-LP-Intake-Secret'] = env.INTAKE_SECRET;
  return h;
}

/* n8n's webhook answers the browser with a 303 today; the Worker does not follow it.
   Any 2xx or 3xx means n8n has the submission. */
export const isDelivered = status => status >= 200 && status < 400;

/* Times in messages to the owner are Lisbon wall-clock. */
export function lisbon(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

/* Telegram texts: a count and a time, never anything the visitor typed. */
export const alertText = (count, oldestIso) =>
  `Website forms: ${count} submission${count === 1 ? '' : 's'} waiting to reach n8n, the oldest since ${lisbon(oldestIso)} (Lisbon). They are stored safely and will be delivered as soon as n8n answers.`;
export const clearedText = nowIso =>
  `Website forms: cleared. Every waiting submission reached n8n by ${lisbon(nowIso)} (Lisbon).`;
export const lostText = nowIso =>
  `Website forms: a submission at ${lisbon(nowIso)} (Lisbon) could NOT be stored or delivered. The visitor was shown an error page asking them to email the studio.`;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const COPY = {
  en: {
    title: 'Your message did not go through',
    lead: 'Something went wrong on our side and we could not receive your form. Nothing was sent.',
    ask: 'Please email us instead at',
    keep: 'Here is what you wrote, so you can copy it:',
    back: 'Back to the page you came from',
  },
  pt: {
    title: 'A sua mensagem não foi enviada',
    lead: 'Algo correu mal do nosso lado e não conseguimos receber o seu formulário. Nada foi enviado.',
    ask: 'Por favor, escreva-nos para',
    keep: 'Eis o que escreveu, para o poder copiar:',
    back: 'Voltar à página onde estava',
  },
};

/* The page a visitor sees only when the submission could be neither stored nor
   delivered. It loads nothing from another origin. */
export function failurePage(params, env) {
  const lang = langOf(params);
  const t = COPY[lang];
  const origin = setting(env, 'SITE_ORIGIN');
  const mail = setting(env, 'STUDIO_EMAIL');
  const back = absolute(origin, safePath(params.get('source_page'), lang));
  const message = params.get('message') || '';
  const kept = message
    ? `<p>${t.keep}</p><textarea readonly rows="8">${esc(message)}</textarea>`
    : '';
  return `<!doctype html>
<html lang="${lang === 'pt' ? 'pt-PT' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${t.title} — Lumen and Pixel</title>
<style>
body{margin:0;background:#021829;color:#f5f1e8;font:16px/1.6 system-ui,sans-serif}
main{max-width:40rem;margin:0 auto;padding:4rem 1rem}
h1{font-size:1.75rem;line-height:1.2;margin:0 0 1rem}
a{color:#f5f1e8}
textarea{width:100%;box-sizing:border-box;font:inherit;padding:.75rem;background:#f5f1e8;color:#021829;border:0}
</style>
</head>
<body>
<main>
<h1>${t.title}</h1>
<p>${t.lead}</p>
<p>${t.ask} <a href="mailto:${mail}">${mail}</a>.</p>
${kept}
<p><a href="${esc(back)}">${t.back}</a></p>
</main>
</body>
</html>`;
}
