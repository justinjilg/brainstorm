/**
 * SQLite schema for the harness index.
 *
 * Per spec `## Index Coherence and Drift Architecture` engineering details:
 *   - SQLite at ~/.brainstorm/harness-index/{harness-id}.db (WAL mode)
 *   - Per-table indexes on owner, references, tags, time fields
 *
 * Per Decision #4 + PQC §4.4 Option C: the *file* on disk is encrypted at
 * rest using packages/vault primitives. This module exposes the in-memory
 * schema; encryption-at-rest is the desktop's responsibility.
 *
 * Schema versioning: bump SCHEMA_VERSION when changing tables. Migrations
 * are applied incrementally on openIndex(); old versions either auto-
 * migrate or fail loudly with a hint to run `brainstorm harness reindex
 * --full` (which rebuilds from FS).
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
-- Master metadata
CREATE TABLE IF NOT EXISTS harness_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per indexed artifact under the harness root.
-- relative_path is the canonical key (relative to harness root).
CREATE TABLE IF NOT EXISTS indexed_artifacts (
  relative_path  TEXT PRIMARY KEY,
  -- File system metadata for cold-open verification (mtime, size, hash triple)
  mtime_ms       INTEGER NOT NULL,
  size_bytes     INTEGER NOT NULL,
  content_hash   TEXT    NOT NULL,
  -- Schema version of the parser that produced this entry
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- Timestamps
  indexed_at     INTEGER NOT NULL,
  -- Parsed-out metadata for fast queries (NULL when artifact lacks the field)
  owner          TEXT,
  status         TEXT,
  artifact_kind  TEXT,
  -- Last-reviewed timestamp (from frontmatter); drives stale-artifact detector
  reviewed_at    INTEGER,
  -- ChangeSet that last touched this entry (NULL for non-tracked writes)
  last_changeset TEXT
);

CREATE INDEX IF NOT EXISTS idx_artifacts_owner       ON indexed_artifacts(owner) WHERE owner IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_kind        ON indexed_artifacts(artifact_kind) WHERE artifact_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_reviewed_at ON indexed_artifacts(reviewed_at) WHERE reviewed_at IS NOT NULL;

-- Junction table: which tags appear on which artifact
CREATE TABLE IF NOT EXISTS artifact_tags (
  relative_path TEXT NOT NULL REFERENCES indexed_artifacts(relative_path) ON DELETE CASCADE,
  tag           TEXT NOT NULL,
  PRIMARY KEY (relative_path, tag)
);
CREATE INDEX IF NOT EXISTS idx_artifact_tags_tag ON artifact_tags(tag);

-- Junction table: directed reference edges between artifacts
-- (e.g., team/humans/justin.toml#references = ["customers/accounts/acme"])
CREATE TABLE IF NOT EXISTS artifact_references (
  source_path  TEXT NOT NULL REFERENCES indexed_artifacts(relative_path) ON DELETE CASCADE,
  target_ref   TEXT NOT NULL,
  reference_type TEXT,
  PRIMARY KEY (source_path, target_ref)
);
CREATE INDEX IF NOT EXISTS idx_refs_target ON artifact_references(target_ref);

-- Drift state — current known drift between intent (file) and observation
-- (runtime). Populated by drift detectors; cleared on resolution.
-- Note: index-class drift (FS↔index) is handled in coldOpenVerify and not
-- recorded here; this table is for intent/runtime drift surfaced to users.
CREATE TABLE IF NOT EXISTS drift_state (
  id              TEXT PRIMARY KEY,
  relative_path   TEXT NOT NULL,
  field_path      TEXT NOT NULL,
  field_class     TEXT NOT NULL,
  detected_at     INTEGER NOT NULL,
  resolved_at     INTEGER,
  intent_value    TEXT,
  observed_value  TEXT,
  detector_name   TEXT NOT NULL,
  severity        TEXT
);
CREATE INDEX IF NOT EXISTS idx_drift_unresolved ON drift_state(detected_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_drift_path        ON drift_state(relative_path);

-- ChangeSet log — tracks proposed/applied/reverted operations
CREATE TABLE IF NOT EXISTS changeset_log (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  state          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  applied_at     INTEGER,
  reverted_at    INTEGER,
  actor_ref      TEXT NOT NULL,
  drift_id       TEXT,
  payload_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changesets_state ON changeset_log(state);

-- Recipient bundle index — denormalized snapshot of recipient bundles
-- detected in .harness/recipients/. Used by the encryption-coherence
-- detector (per Decision #11 revised).
CREATE TABLE IF NOT EXISTS recipient_bundles (
  bundle_id      TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  version        INTEGER NOT NULL,
  status         TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  indexed_at     INTEGER NOT NULL
);
`;
