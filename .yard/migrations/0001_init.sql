-- Chalk schema. Every statement is idempotent: migration files are not
-- transactional, so a mid-file failure leaves earlier statements applied and
-- the file unrecorded in _yard_migrations, which re-runs it from the top on
-- the next deploy. IF NOT EXISTS makes that re-run harmless.
--
-- Shapes are not here. Each board's drawing lives inside its object, which
-- holds the live connections; the database only knows who owns which board,
-- who has joined it, and a summary the object writes back now and then.

-- One row per person who has opened the app. plan is a snapshot of the tier
-- the edge reported on their last visit, which is how a board can enforce its
-- owner's limits while the owner is not connected.
CREATE TABLE IF NOT EXISTS users (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  email   TEXT NOT NULL DEFAULT '',
  plan    TEXT NOT NULL DEFAULT 'free',
  seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS boards (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  link_access INTEGER NOT NULL DEFAULT 0,
  shape_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_boards_owner ON boards (owner_id, updated_at);

-- People who joined a board through its link. The owner is not listed here;
-- ownership is boards.owner_id.
CREATE TABLE IF NOT EXISTS board_members (
  board_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (board_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_members_user ON board_members (user_id);
