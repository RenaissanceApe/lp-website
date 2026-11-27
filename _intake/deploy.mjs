/* Deploys the form front door with Cloudflare's REST API. Node 22, no packages.
 * Run by .github/workflows/intake-deploy.yml; never by the site.
 *
 * Environment (GitHub secrets, set by the owner):
 *   CLOUDFLARE_API_TOKEN   token limited to: Account · Workers Scripts · Edit,
 *                          Account · D1 · Edit, Zone · Workers Routes · Edit (this zone only)
 *   CLOUDFLARE_ACCOUNT_ID
 *   INTAKE_D1_ID           the D1 database (created in the EU jurisdiction)
 *   CLOUDFLARE_ZONE_ID     optional: when set, the routes below are attached
 *
 * Steps: apply schema.sql (idempotent) → upload the Worker, keeping the secrets
 * set in the dashboard → set the cron → attach the routes.
 * With any required value missing it prints why and exits 0, so CI stays green.
 */
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'lp-intake';
const CRON = '* * * * *';
const COMPATIBILITY_DATE = '2025-11-01';
/* The address the forms post to. Changing it is a one-line change here plus
   the form action in the four pages (see _docs/FORM_FRONT_DOOR.md). */
const ROUTES = ['www.lumenandpixel.com/intake', 'lumenandpixel.com/intake'];

const here = import.meta.dirname;
const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, INTAKE_D1_ID: d1, CLOUDFLARE_ZONE_ID: zone } = process.env;

const missing = Object.entries({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, INTAKE_D1_ID: d1 })
  .filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.log(`Skipping deploy: not set: ${missing.join(', ')}. See _docs/FORM_FRONT_DOOR.md.`);
  process.exit(0);
}

const API = 'https://api.cloudflare.com/client/v4';
async function cf(method, url, body, headers = {}) {
  const res = await fetch(API + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const why = (json.errors || []).map(e => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
    throw new Error(`${method} ${url} failed: ${why}`);
  }
  return json.result;
}
const json = body => [JSON.stringify(body), { 'Content-Type': 'application/json' }];

// 1. Schema, one statement at a time.
const statements = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8')
  .replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
for (const sql of statements) await cf('POST', `/accounts/${account}/d1/database/${d1}/query`, ...json({ sql }));
console.log(`Schema applied (${statements.length} statements).`);

// 2. Upload the Worker. keep_bindings preserves the secrets and variables set in the dashboard.
const form = new FormData();
form.append('metadata', new Blob([JSON.stringify({
  main_module: 'worker.mjs',
  compatibility_date: COMPATIBILITY_DATE,
  bindings: [{ type: 'd1', name: 'DB', database_id: d1 }],
  keep_bindings: ['secret_text', 'plain_text'],
})], { type: 'application/json' }));
for (const file of ['worker.mjs', 'logic.mjs']) {
  const src = fs.readFileSync(path.join(here, 'src', file));
  form.append(file, new Blob([src], { type: 'application/javascript+module' }), file);
}
await cf('PUT', `/accounts/${account}/workers/scripts/${NAME}`, form);
console.log(`Worker ${NAME} uploaded.`);

// 3. Cron.
await cf('PUT', `/accounts/${account}/workers/scripts/${NAME}/schedules`, ...json([{ cron: CRON }]));
console.log(`Cron set: ${CRON}.`);

// 4. Routes on the site's own domain.
if (zone) {
  const existing = await cf('GET', `/zones/${zone}/workers/routes`);
  for (const pattern of ROUTES) {
    const found = existing.find(r => r.pattern === pattern);
    if (found && found.script === NAME) { console.log(`Route ok: ${pattern}`); continue; }
    if (found) await cf('PUT', `/zones/${zone}/workers/routes/${found.id}`, ...json({ pattern, script: NAME }));
    else await cf('POST', `/zones/${zone}/workers/routes`, ...json({ pattern, script: NAME }));
    console.log(`Route set: ${pattern} → ${NAME}`);
  }
} else {
  console.log('CLOUDFLARE_ZONE_ID not set: no route attached.');
}
console.log('Done.');
