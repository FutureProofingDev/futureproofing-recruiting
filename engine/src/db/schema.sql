-- AI Candidate Evaluation Engine — D1 schema
-- Conventions follow the sibling Cloudflare projects in this account:
-- INTEGER PRIMARY KEY AUTOINCREMENT, datetime('now') ISO timestamps,
-- JSON stored as TEXT, explicit indices, no soft deletes.

-- One row per Ashby application being tracked by any registered pipeline.
CREATE TABLE IF NOT EXISTS candidates (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ashby_application_id TEXT NOT NULL UNIQUE,
  ashby_candidate_id  TEXT,
  pipeline_key        TEXT NOT NULL,        -- e.g. "ai-engineer" — matches pipelines/index.js registry key
  name                TEXT,
  email               TEXT,
  job_title           TEXT,
  current_stage       TEXT,
  first_seen_at_trigger_stage TEXT,         -- when it first reached the pipeline's trigger stage
  last_polled_at      TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_candidates_pipeline_key ON candidates(pipeline_key);
CREATE INDEX IF NOT EXISTS idx_candidates_current_stage ON candidates(current_stage);

-- Cached Ashby dossier fetch per candidate. Lets us detect "did anything
-- change since the last generation" without re-hitting the Ashby API, and
-- lets a prompt-version bump regenerate off the same source data.
CREATE TABLE IF NOT EXISTS raw_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id   INTEGER NOT NULL REFERENCES candidates(id),
  content_hash   TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  fetched_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_raw_snapshots_candidate ON raw_snapshots(candidate_id, fetched_at DESC);

-- Append-only: every generation is a new row, nothing is ever overwritten.
-- "Current" evaluation for a stage = the latest row for (candidate_id, stage_key).
-- This is what preserves how the candidate evolved across the whole process.
CREATE TABLE IF NOT EXISTS stage_evaluations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id   INTEGER NOT NULL REFERENCES candidates(id),
  stage_key      TEXT NOT NULL,        -- from the pipeline's stage definitions (e.g. "recruiter_interview")
  stage_name     TEXT,                 -- the actual Ashby stage/form title, for display
  eval_type      TEXT NOT NULL,        -- which prompt/schema generated this (e.g. "recruiter_feedback")
  prompt_version TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_hash     TEXT NOT NULL,        -- hash of the dossier slice this eval was generated from
  output_json    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'complete', -- 'complete' | 'error'
  error_message  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stage_evaluations_candidate_stage
  ON stage_evaluations(candidate_id, stage_key, created_at DESC);

-- Append-only, same shape. Each row references the stage_evaluations ids it
-- was synthesized from (JSON array) so a summary is always reproducible.
CREATE TABLE IF NOT EXISTS final_summaries (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id           INTEGER NOT NULL REFERENCES candidates(id),
  based_on_evaluation_ids TEXT NOT NULL, -- JSON array of stage_evaluations.id
  input_hash             TEXT NOT NULL, -- hash of the stage evaluations synthesized, for staleness checks
  prompt_version         TEXT NOT NULL,
  model                  TEXT NOT NULL,
  output_json            TEXT NOT NULL,
  recommendation         TEXT,          -- 'proceed' | 'proceed_with_caution' | 'reject' — denormalized for quick listing
  confidence             TEXT,
  status                 TEXT NOT NULL DEFAULT 'complete',
  error_message          TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_final_summaries_candidate
  ON final_summaries(candidate_id, created_at DESC);

-- Manually entered notes — things a recruiter knows (e.g. from the "Chat
-- with Jess" conversation itself) that the automated pipeline can't derive
-- from Ashby scorecards. Append-only like the generated tables; "current"
-- for a given note_type = the latest row per (candidate_id, note_type).
CREATE TABLE IF NOT EXISTS manual_notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  note_type    TEXT NOT NULL,        -- e.g. "employment_history"
  content_json TEXT NOT NULL,
  added_by     TEXT,                 -- who entered it, if known
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_manual_notes_candidate_type
  ON manual_notes(candidate_id, note_type, created_at DESC);

-- Cron bookkeeping, one row per pipeline key.
CREATE TABLE IF NOT EXISTS poll_state (
  pipeline_key TEXT PRIMARY KEY,
  last_run_at  TEXT
);
