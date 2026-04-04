-- Stacked D1 Schema

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                        -- Clerk user ID (user_...)
  email TEXT NOT NULL,
  name TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  plan TEXT NOT NULL DEFAULT 'free',          -- 'free' | 'pro'
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'inactive',
  current_period_end INTEGER                  -- unix timestamp
);

CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,                        -- e.g. '2025-06'
  tailor_count INTEGER DEFAULT 0,
  coverletter_count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, month),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_users_stripe_sub ON users(stripe_subscription_id);
