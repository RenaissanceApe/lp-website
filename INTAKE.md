# Intake contract

The site's only cross-system contract: what its forms send, who receives it,
what reaches n8n, and what the visitor gets back. If a form changes, this file
changes in the same PR.

Since v1.63 the forms post to the **form front door**, a Cloudflare Worker on the
site's own domain. It stores each submission, answers the visitor, and forwards
the unchanged body to n8n, retrying until n8n confirms. How it works and how it
is run: [`_docs/FORM_FRONT_DOOR.md`](_docs/FORM_FRONT_DOOR.md); code in `_intake/`.

## Endpoint

```
POST https://www.lumenandpixel.com/intake
Content-Type: application/x-www-form-urlencoded
```

- Every form on the site posts here. `form_type` tells them apart.
- `/intake` is a Cloudflare Worker route on the site's own domain, not a page:
  GitHub Pages never sees these requests. A `GET` there redirects to `/`.
- Submission is a **native HTML form POST**. No JavaScript sends anything.
- The browser enforces `required` fields and `type="email"` before posting.
- The endpoint is public by design (see *Posture* below).

## Forms

| `form_type` | Pages |
|---|---|
| `contact` | `about.html`, `pt/about.html` |
| `newsletter` | `index.html`, `pt/index.html` |

`quiz` and `download` are reserved `form_type` values. No form uses them yet:
the quiz hands off to the contact form through `?service=`, and there are no
gated downloads.

## Fields

| Field | `contact` | `newsletter` | Notes |
|---|---|---|---|
| `form_type` | `contact` | `newsletter` | hidden |
| `lang` | `en` or `pt` | `en` or `pt` | hidden, matches the page language |
| `source_page` | `/about.html` or `/pt/about.html` | `/` or `/pt/` | hidden; the homepage sends its canonical path |
| `email` | required | required | `type="email"` |
| `name` | required | — | |
| `company` | optional | — | |
| `service` | optional | — | one of: `Show Design`, `Show Control & Automation`, `System Architecture`, `Technical Direction`, `Not sure yet`, or empty. English values in both languages. |
| `message` | required | — | up to 4000 characters |
| `quiz_result` | hidden | — | empty unless the visitor came from the quiz; then one of the four service names above, mapped from `?service=SD\|SC\|SA\|TD` |
| `consent` | optional | **required** | checkbox, `value="yes"`. **Absent** when unticked. Never pre-ticked. |
| `lp_ref_code` | honeypot | honeypot | must arrive **empty** |

Field names are identical in both languages.

## Consent wording

The consent checkbox label is identical on both forms. Rendered text, exactly:

- **EN:** `Send me occasional emails from Lumen and Pixel. Unsubscribe at any time. See our Privacy Policy.`
- **PT:** `Enviem-me emails ocasionais da Lumen and Pixel. Pode cancelar a subscrição a qualquer momento. Consulte a nossa Política de Privacidade.`

"Privacy Policy" / "Política de Privacidade" links to `legal.html#privacy`.
The form sends only `consent=yes`; the receiver records which wording was
agreed to from `lang`. Changing a label means updating this file and the
record of wording in the same PR.

## Honeypot

`lp_ref_code` is a text input hidden from people by `.hp-field` in `site.css`
(off-screen, not `type="hidden"`), with `tabindex="-1"` and
`autocomplete="off"`. People never fill it; many bots do. **The receiver must
discard any submission where it is not empty.** The page does no screening of
its own.

It is deliberately not named `website`: browsers autofill fields with that
name, which would discard real visitors.

## Response

The Worker answers the visitor itself, before n8n has seen anything, with a
**303 redirect** to an absolute URL on `https://www.lumenandpixel.com`:

| `form_type` | `lang=en` | `lang=pt` |
|---|---|---|
| `contact` | `/thank-you.html` | `/pt/thank-you.html` |
| `newsletter` | `/check-your-inbox.html` | `/pt/check-your-inbox.html` |

Any `lang` other than `pt` is treated as `en`. The visitor is sent back with a
303 to `source_page` (or to `/` or `/pt/` when `source_page` is not a plain path
on this site) when:

- the `email` is empty, longer than 254 characters or not `x@y.z`;
- the `form_type` is not `contact` or `newsletter`.

This mirrors n8n v2-01's own redirect rule. Those submissions are **still stored
and forwarded**: n8n is the single screener and logs every submission it skips
("skipped" in the Ops Log). The honeypot is **not** checked here; n8n gives spam
the normal done page, so the visitor-side answer is the same.

A body over 32 KB gets `413` and is not stored.

If the submission can be neither stored nor delivered to n8n directly, the visitor
gets a `503` page in their language saying it did not go through, asking them to
email `info@lumenandpixel.com`, and showing their message so they can copy it.

The site does not inspect the response beyond following the redirect.

## Front door: store, forward, retry

1. **Store.** Each submission is written to a D1 database created in
   Cloudflare's EU jurisdiction: an id, the time received, `form_type`, `lang`
   and the body exactly as the browser sent it. The visitor's IP address and
   headers are not stored.
2. **Redirect** the visitor (above).
3. **Forward** right after the response, then from a cron run every minute until
   n8n confirms. While n8n is unreachable, each run sends one probe, not one
   request per waiting submission.
4. **Alert.** When a submission has waited more than 10 minutes, one Telegram
   message to the owner: a count and a time, nothing the visitor typed. One more
   when everything has gone through. Also one message if a submission could be
   neither stored nor delivered.
5. **Retention.** A stored copy is deleted **7 days after n8n confirmed it**.
   Unconfirmed copies are kept until n8n confirms.
6. If storing fails, the Worker forwards to n8n while the visitor waits; if that
   succeeds the visitor is redirected as normal.

Delivery is **at least once**: a retry after a lost answer can deliver a
submission twice, with the same `X-LP-Submission-Id`.

## Forwarding to n8n

```
POST <N8N_WEBHOOK_URL>            a Worker secret: n8n Cloud's /webhook/inbound-lead,
                                  later the home n8n's address
Content-Type: application/x-www-form-urlencoded
X-LP-Submission-Id: <uuid>        the same on every retry; de-duplicate on it
X-LP-Received-At: <ISO 8601 UTC>  when the visitor submitted
X-LP-Attempt: <n>                 1 for the first try
X-LP-Intake-Secret: <secret>      only when the INTAKE_SECRET setting exists
```

- The body is byte-for-byte what the browser sent: the fields above, honeypot
  included. n8n changes nothing to receive it.
- **Success is a 2xx, or a 303 whose `Location` is an absolute `https://` URL on
  `lumenandpixel.com` or `www.lumenandpixel.com`** (n8n's own redirect to the done
  page; the Worker does not follow it). **n8n must answer the webhook with one of
  those**, wherever it runs. Any other 3xx (for example a tunnel or access gate
  sending a login page), a relative `Location`, any other status, no answer within
  10 seconds, or a network error means "not delivered": the row is kept and
  retried, and only the host of a refused redirect is recorded.
- n8n sees Cloudflare's address, not the visitor's.
- n8n answers right after its Normalize step, before Notion, Telegram and email
  run: "delivered" means n8n received it, not that those steps worked. v2-01's
  error handler (v2-00) covers them.
- Agreed with Ops (owner of v2-01) on 27 Nov 2026, the success rule tightened the
  same day so a misrouted redirect can never count as delivered; their copy is
  `ops/n8n-home/FORWARDING_CONTRACT.md` in lp-ops. n8n checking the secret and
  de-duplicating on `X-LP-Submission-Id` are proposed to the owner after the move.

## Posture

Public endpoint, native form POST, honeypot `lp_ref_code`, **no shared
secret in the page**: a public form cannot hold one, because anything in the
page is readable by anyone. Screening happens on the n8n side. The optional
`X-LP-Intake-Secret` lives only between the Worker and n8n, so n8n can refuse
anything that did not come through the front door.

## Downstream (outside this repo)

Recorded so a reader knows where the data goes; the site depends only on the
contract above.

- The forms reach n8n only through the Worker above.
- Newsletter signups go to **Brevo** via n8n workflow v2-01. Brevo runs
  double opt-in (its confirmation email, in the visitor's language) and
  records the confirmation. n8n also sends Brevo the language, source page,
  consent wording and time as contact attributes.
- Consent wording and timestamp are stored on the **Notion** contact.
- The site never implements email logic.
