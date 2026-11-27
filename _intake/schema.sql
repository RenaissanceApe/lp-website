-- Form front door storage (D1, EU jurisdiction). Safe to run again: every
-- statement is IF NOT EXISTS. The deploy job applies it before each upload.

-- One row per accepted submission. body is the form exactly as the browser sent
-- it; it is what gets forwarded to n8n. forwarded_at is set when n8n confirmed
-- (2xx, or 303 back to the site); the row is deleted RETENTION_DAYS after that. Rows n8n has not
-- confirmed are kept until it does.
CREATE TABLE IF NOT EXISTS submissions (
  id              TEXT PRIMARY KEY,      -- sent to n8n as X-LP-Submission-Id
  received_at     TEXT NOT NULL,         -- ISO 8601 UTC, sent as X-LP-Received-At
  form_type       TEXT NOT NULL,         -- as sent (contact | newsletter; anything else is forwarded too)
  lang            TEXT NOT NULL,         -- en | pt
  body            TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT NOT NULL,         -- also a claim, so two runs never send one row at once
  last_result     TEXT,                  -- e.g. "HTTP 303", "TimeoutError"; never personal data
  forwarded_at    TEXT
);

CREATE INDEX IF NOT EXISTS submissions_pending ON submissions (received_at) WHERE forwarded_at IS NULL;
CREATE INDEX IF NOT EXISTS submissions_forwarded ON submissions (forwarded_at) WHERE forwarded_at IS NOT NULL;

-- Small key/value state: 'alert_open' holds when the stalled alert was sent.
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
