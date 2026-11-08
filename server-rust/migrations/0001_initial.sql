CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE,
  balance BIGINT NOT NULL DEFAULT 10000 CHECK (balance >= 0)
);

CREATE TABLE IF NOT EXISTS shared_ledger (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  balance BIGINT NOT NULL CHECK (balance >= 0)
);
INSERT INTO shared_ledger (id, balance) VALUES (1, 50000)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  request_key TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT,
  charged BIGINT NOT NULL DEFAULT 0,
  reserved BIGINT NOT NULL DEFAULT 0,
  created BIGINT NOT NULL,
  started BIGINT,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  fingerprint TEXT,
  UNIQUE (account, request_key)
);
CREATE INDEX IF NOT EXISTS jobs_account_created ON jobs (account, created DESC);
CREATE INDEX IF NOT EXISTS jobs_active_reserved ON jobs (status, reserved) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS video_jobs (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  created BIGINT NOT NULL,
  started BIGINT,
  reserved BIGINT NOT NULL DEFAULT 0,
  charged BIGINT NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL,
  duration INTEGER NOT NULL,
  ratio TEXT NOT NULL,
  resolution TEXT NOT NULL,
  input_url TEXT,
  input_key TEXT,
  provider_id TEXT,
  video_url TEXT,
  error TEXT,
  UNIQUE (account, request_key)
);
CREATE INDEX IF NOT EXISTS video_jobs_account_created ON video_jobs (account, created DESC);
CREATE INDEX IF NOT EXISTS video_jobs_active_reserved ON video_jobs (status, reserved) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS stored_images (
  job TEXT NOT NULL REFERENCES jobs(id),
  idx INTEGER NOT NULL,
  account TEXT NOT NULL,
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  created BIGINT NOT NULL,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  object_url TEXT,
  preview_url TEXT,
  PRIMARY KEY (job, idx)
);
CREATE INDEX IF NOT EXISTS images_account_created ON stored_images (account, created DESC, job, idx);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  created BIGINT NOT NULL,
  expires BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS recharges (
  id TEXT PRIMARY KEY,
  request_key TEXT UNIQUE NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  created BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_assets (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  created BIGINT NOT NULL,
  task TEXT,
  template_id TEXT,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  object_url TEXT,
  preview_url TEXT
);

CREATE TABLE IF NOT EXISTS author_tasks (
  id TEXT PRIMARY KEY,
  request_key TEXT UNIQUE NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  created BIGINT NOT NULL,
  updated BIGINT NOT NULL,
  job_id TEXT,
  result JSONB,
  error TEXT,
  asset_id TEXT
);
