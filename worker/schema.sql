-- Price alerts table
CREATE TABLE IF NOT EXISTS price_alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  from_station TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_station TEXT NOT NULL,
  to_id TEXT NOT NULL,
  travel_date TEXT NOT NULL,
  max_price REAL,
  email TEXT,
  created_at INTEGER NOT NULL,
  last_checked INTEGER,
  last_price REAL,
  active INTEGER DEFAULT 1
);

-- Search history for analytics / trending routes
CREATE TABLE IF NOT EXISTS search_log (
  id TEXT PRIMARY KEY,
  from_station TEXT NOT NULL,
  to_station TEXT NOT NULL,
  travel_date TEXT NOT NULL,
  min_price REAL,
  searched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_user ON price_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON price_alerts(active);
