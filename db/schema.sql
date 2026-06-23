CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL,
  present BOOLEAN NOT NULL,
  headphones BOOLEAN NOT NULL,
  eyes_on_screen BOOLEAN NOT NULL,
  posture TEXT NOT NULL CHECK (posture IN ('upright', 'slouched', 'unknown')),
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  status TEXT NOT NULL CHECK (status IN ('locked_in', 'present', 'away')),
  note TEXT NOT NULL,
  thumb_url TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS snapshots_captured_at_idx ON snapshots (captured_at DESC);

CREATE TABLE IF NOT EXISTS hourly_checkins (
  day DATE NOT NULL,
  hour INTEGER NOT NULL CHECK (hour >= 0 AND hour <= 23),
  avg_score INTEGER NOT NULL CHECK (avg_score >= 0 AND avg_score <= 100),
  present_pct INTEGER NOT NULL CHECK (present_pct >= 0 AND present_pct <= 100),
  headphones_pct INTEGER NOT NULL CHECK (headphones_pct >= 0 AND headphones_pct <= 100),
  verdict TEXT NOT NULL,
  PRIMARY KEY (day, hour)
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  blur BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

INSERT INTO settings (id, paused, blur)
VALUES (1, FALSE, FALSE)
ON CONFLICT (id) DO NOTHING;
