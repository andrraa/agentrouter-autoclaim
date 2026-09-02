CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  github_cookie TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_claim_at TEXT,
  last_result TEXT
);
