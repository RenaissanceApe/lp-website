# Form front door

The site's two forms (contact on About, newsletter on Home, EN and PT) post to
`https://www.lumenandpixel.com/intake`. That address is a small **Cloudflare Worker**, not a
page. It exists because n8n moves from n8n Cloud to a computer at home that can be switched off:
the Worker is always on, so no submission is lost while n8n is away. Built in v1.63; the contract
is [`INTAKE.md`](../INTAKE.md); the code is in `_intake/`.

## How it works

```
visitor's browser ──POST /intake──▶ Worker ──store──▶ D1 database (EU)
        ◀──303 to thank-you / check-your-inbox──┘   │
                                                    └──forward──▶ n8n (N8N_WEBHOOK_URL)
                     every minute: retry what n8n has not confirmed
```

1. The Worker stores the form exactly as sent and sends the visitor to the thank-you or
   check-your-inbox page in their language (or back to the form when the email or `form_type`
   is wrong, the same rule n8n uses). The visitor never waits for n8n. Every form is stored and
   forwarded, even a wrong one: n8n is the one place that screens and logs what it skips.
2. Straight after, it sends the same form to n8n, with a submission id. n8n answering 2xx, or 303
   back to the site (its own redirect), means "got it". Any other redirect, such as a tunnel's
   login page, does not count: the form is kept and retried.
3. A run every minute retries anything n8n has not confirmed. While n8n is off it sends one try a
   minute, not one per waiting form.
4. If something has waited **more than 10 minutes**, you get **one** Telegram message: how many
   and since when. Nothing the visitor wrote. When they have all gone through, one "cleared"
   message.
5. Stored copies are deleted **7 days after n8n confirmed them**. Unconfirmed ones stay until n8n
   confirms.
6. If the database itself fails, the Worker sends the form to n8n while the visitor waits. If
   that also fails, the visitor sees a page (EN or PT) saying it did not go through, with
   `info@lumenandpixel.com` and a copy of their message to paste into an email; you get a
   Telegram message saying a submission was lost (time only).

**Why 7 days.** n8n confirming means it has the form, not that Notion, Brevo and the alert all
worked. A week covers a weekend plus the days after it, so a failed n8n run can be replayed from
the stored copy; after that the copy is only a duplicate of what Notion holds.

**Why a route on the site's own domain** (not `something.workers.dev`): the form keeps posting to
the site's own address, so nothing new appears in the browser and there is no placeholder to
replace. It needs one extra token permission (Workers Routes on the zone). It is zone
configuration, not a DNS record.

**The route cannot hide a real page.** The patterns are `www.lumenandpixel.com/intake` and
`lumenandpixel.com/intake`, with no `*`, so they match only the path `/intake` exactly. The
repository has no file or folder at `/intake`, `/intake.html` or `/intake/` (checked 27 Nov
2026 with `git ls-files`; the only near names are `INTAKE.md`, a different path, and the
unpublished `_intake/`). Both host names are behind Cloudflare's proxy, so no DNS change.
The forms post to `www` (the canonical host, `CNAME`). The apex route is there so a POST that
reaches `lumenandpixel.com/intake` is answered by the Worker too, instead of being redirected by
GitHub Pages to `www`, which would turn it into a GET and lose the form.

**Free plan, checked 27 Nov 2026 on developers.cloudflare.com:** Workers 100,000 requests a day,
10 ms CPU per request, 50 outgoing requests per run, 5 cron triggers per account (we use 1);
D1 5 million rows read and 100,000 rows written a day, 5 GB, 10 databases. A cron run every minute
is 1,440 runs a day. The forms get a handful of submissions a day.

## Settings

| Where | Name | What |
|---|---|---|
| Worker secret | `N8N_WEBHOOK_URL` | n8n's inbound-lead webhook. **The one setting that says where n8n is.** n8n Cloud today: `https://lumenandpixel.app.n8n.cloud/webhook/inbound-lead`; the home address after the move |
| Worker secret | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | for the waiting / cleared / lost messages (the same bot n8n uses is fine) |
| Worker secret | `INTAKE_SECRET` | optional; when present, sent to n8n as `X-LP-Intake-Secret` so n8n can refuse anything else |
| Worker variable | `ALERT_AFTER_MINUTES`, `RETENTION_DAYS` | optional; defaults 10 and 7 |
| GitHub secret | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `INTAKE_D1_ID`, `CLOUDFLARE_ZONE_ID` | for the deploy job |

Settings set in the Cloudflare dashboard survive every redeploy.

## Monday 30 Nov: your steps, in this order

Do not merge the pull request until step 9. Until then the live forms still post to n8n Cloud as
today. No secret goes in a file, a commit or a chat: only in the secure fields named below.

**1. Create the database (EU).** Cloudflare dashboard → *Storage & databases* → *D1 SQL Database*
→ *Create*. Name: `lp-intake`. Under location, choose **Specify jurisdiction → European Union
(EU)** (this cannot be changed later). Create. Copy the **Database ID** shown on its page.

**2. Create the API token.** Dashboard → your profile icon → *My Profile* → *API Tokens* →
*Create Token* → *Create Custom Token*. Name: `lp-website intake deploy`. Permissions, exactly:

- Account · **Workers Scripts** · Edit
- Account · **D1** · Edit
- Zone · **Workers Routes** · Edit

Account resources: your account. Zone resources: *Specific zone* → `lumenandpixel.com`. Nothing
else: no DNS permission. *Continue to summary* → *Create Token*. Copy the token (shown once).

**3. Find two ids.** On the dashboard home page of `lumenandpixel.com`, the right-hand column shows
**Zone ID** and **Account ID**. Copy both.

**4. Put them in GitHub.** github.com/RenaissanceApe/lp-website → *Settings* → *Secrets and
variables* → *Actions* → *New repository secret*, four times:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID |
| `CLOUDFLARE_ZONE_ID` | Zone ID |
| `INTAKE_D1_ID` | Database ID from step 1 |

**5. Deploy the Worker.** Open the pull request → *Labels* (right-hand column) → add the label
**`deploy-intake`** (create it if GitHub asks). Then *Actions* tab → *intake-deploy* → the newest
run should go green and end with `Done.` If it fails, the log names the step and Cloudflare's
reason (usually a missing permission on the token).

**6. Set the Worker's secrets.** Cloudflare dashboard → *Workers & Pages* → **lp-intake** →
*Settings* → *Variables and Secrets* → *Add*, type **Secret**, for each:

- `N8N_WEBHOOK_URL` = `https://lumenandpixel.app.n8n.cloud/webhook/inbound-lead` (or the home
  address if home n8n is already live and reachable from the internet)
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` = the bot's token and your chat id
- `INTAKE_SECRET` only if you said yes to the shared secret and n8n checks it

*Deploy* / save.

**7. One test submission.** On a Mac, open *Terminal* and paste:

```
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://www.lumenandpixel.com/intake \
  --data-urlencode form_type=contact --data-urlencode lang=en \
  --data-urlencode source_page=/about.html --data-urlencode "name=Front door test" \
  --data-urlencode email=YOUR-OWN-ADDRESS --data-urlencode "message=Front door test, ignore" \
  --data-urlencode lp_ref_code=
```

Expected: `303 https://www.lumenandpixel.com/thank-you.html`, and within a minute the test lead in
Notion, the n8n alert and the Gmail email, as for a real enquiry. In the dashboard, *D1* →
`lp-intake` → *Console*, `SELECT id, received_at, attempts, last_result, forwarded_at FROM
submissions;` shows the row with `forwarded_at` filled.

**8. The same with n8n unreachable for ten minutes.** In the Worker's *Variables and Secrets*,
edit `N8N_WEBHOOK_URL` and add `-off` at the end (it now points nowhere). Run the command from
step 7 again with `message=Front door outage test`. Expected:

- the command still prints `303 …/thank-you.html` (the visitor notices nothing);
- after about 10–11 minutes, **one** Telegram message: "1 submission waiting to reach n8n, the
  oldest since …";
- put `N8N_WEBHOOK_URL` back as it was; within about a minute the test lead arrives in Notion, and
  Telegram says "cleared".

**9. Merge the pull request.** The forms now post to the Worker. Within a few minutes of the merge,
send one real newsletter sign-up from Home in PT and check you land on the Portuguese
check-your-inbox page and get Brevo's confirmation email.

**After the n8n move:** change only `N8N_WEBHOOK_URL` to the home address (step 6). Nothing on the
site changes. Anything sent while home n8n is off waits and arrives when it is back.

## Rolling back

- **Forms back to n8n Cloud directly:** revert the pull request on GitHub (*Revert* button on the
  merged PR, then merge the revert). The four form `action`s go back to
  `https://lumenandpixel.app.n8n.cloud/webhook/inbound-lead`. Anything still waiting in the
  Worker keeps being retried as long as the Worker runs.
- **Stop the Worker entirely:** first revert as above, wait until the D1 console shows no row with
  an empty `forwarded_at`, then delete the routes (Worker → *Settings* → *Domains & Routes*).

## Using workers.dev instead of the route

If you'd rather not give the token the zone permission: leave out `CLOUDFLARE_ZONE_ID` and the
Zone permission, enable the Worker's `workers.dev` address in its *Settings → Domains & Routes*,
and change the form `action` in `index.html`, `about.html`, `pt/index.html`, `pt/about.html`
(one line each) from `https://www.lumenandpixel.com/intake` to that address. The forms then
post to a second origin, which the Legal page's sentence "your browser sends it to this website's
own address" would no longer match.

## For developers

```
node --test '_intake/test/*.test.mjs'   # logic, plus end to end on SQLite with the real schema
node _intake/deploy.mjs                 # what the job runs; exits 0 when secrets are missing
```

`src/worker.mjs` is only the entry point (Workers treat a main module's named exports as entry
points); `src/intake.mjs` holds the request and cron logic; `src/logic.mjs` the pure rules.
No packages: the deploy script uses Cloudflare's REST API with Node's `fetch`.
