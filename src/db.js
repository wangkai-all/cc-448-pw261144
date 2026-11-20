import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subjects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  channel       TEXT NOT NULL,
  contact_hint  TEXT NOT NULL,
  legal_hold    INTEGER NOT NULL DEFAULT 0,
  hold_reason   TEXT,
  created_at    TEXT NOT NULL
);

-- 授权快照：每次变更生成不可变版本，terms_hash 绑定条款内容。
CREATE TABLE IF NOT EXISTS snapshots (
  id             TEXT PRIMARY KEY,
  subject_id     TEXT NOT NULL REFERENCES subjects(id),
  version        INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active','revoked')),
  purposes       TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  retention_days INTEGER NOT NULL,
  terms_hash     TEXT NOT NULL,
  reason         TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'consent-platform',
  received_at    TEXT NOT NULL,
  effective_at   TEXT NOT NULL,
  notice_key     TEXT NOT NULL,
  prev_id        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS snapshots_subject_version ON snapshots(subject_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS snapshots_notice ON snapshots(notice_key);

-- 采集批次：创建时冻结当时的授权快照 id + 条款哈希。
CREATE TABLE IF NOT EXISTS batches (
  id               TEXT PRIMARY KEY,
  subject_id       TEXT NOT NULL REFERENCES subjects(id),
  source           TEXT NOT NULL,
  purpose          TEXT NOT NULL,
  scopes           TEXT NOT NULL,
  fields           TEXT NOT NULL,
  retention_days   INTEGER NOT NULL,
  snapshot_id      TEXT NOT NULL REFERENCES snapshots(id),
  snapshot_version INTEGER NOT NULL,
  terms_hash       TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                     ('collecting','sealed','blocked','degraded','deleted','quarantined')),
  block_code       TEXT,
  block_reason     TEXT,
  compliance       TEXT NOT NULL DEFAULT 'ok' CHECK (compliance IN ('ok','overbroad','revoked')),
  requested_retention INTEGER,
  legal_hold       INTEGER NOT NULL DEFAULT 0,
  hold_reason      TEXT,
  record_count     INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT NOT NULL,
  sealed_at        TEXT,
  flagged_at       TEXT,
  flagged_by_snapshot TEXT,
  disposed_action  TEXT,
  disposed_at      TEXT,
  disposed_by_job  TEXT
);
CREATE INDEX IF NOT EXISTS batches_subject ON batches(subject_id);
CREATE INDEX IF NOT EXISTS batches_snapshot ON batches(snapshot_id);

-- 受管数据记录：删除为物理清除；降级抹除字段；隔离迁出到 vault。
CREATE TABLE IF NOT EXISTS records (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id     TEXT NOT NULL REFERENCES batches(id),
  subject_id   TEXT NOT NULL REFERENCES subjects(id),
  payload      TEXT NOT NULL,
  captured_at  TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('live','degraded')),
  state_reason TEXT,
  state_job    TEXT,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_batch ON records(batch_id);
CREATE INDEX IF NOT EXISTS records_captured ON records(captured_at);

-- 授权变更处置任务：幂等键防重复通知/重复建任务。
CREATE TABLE IF NOT EXISTS jobs (
  id                 TEXT PRIMARY KEY,
  subject_id         TEXT NOT NULL REFERENCES subjects(id),
  trigger            TEXT NOT NULL,
  from_snapshot_id   TEXT,
  to_snapshot_id     TEXT NOT NULL,
  dedupe_key         TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN
                       ('pending','running','paused','completed','failed','cancelled')),
  action             TEXT NOT NULL CHECK (action IN ('delete','quarantine','degrade','mixed','none')),
  impacted_batch_ids TEXT NOT NULL DEFAULT '[]',
  processed_batches  INTEGER NOT NULL DEFAULT 0,
  processed_records  INTEGER NOT NULL DEFAULT 0,
  total_batches      INTEGER NOT NULL DEFAULT 0,
  total_records      INTEGER NOT NULL DEFAULT 0,
  attempts           INTEGER NOT NULL DEFAULT 0,
  checkpoint         TEXT,
  last_error         TEXT,
  notes              TEXT,
  not_before         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  started_at         TEXT,
  completed_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe ON jobs(dedupe_key);
CREATE INDEX IF NOT EXISTS jobs_subject ON jobs(subject_id);

-- 任务 -> 批次 影响清单（落库的显式队列，中断后据此恢复）。
CREATE TABLE IF NOT EXISTS job_targets (
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  batch_id      TEXT NOT NULL REFERENCES batches(id),
  ord           INTEGER NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('delete','quarantine','degrade')),
  kind          TEXT NOT NULL,
  reason        TEXT NOT NULL,
  removed_scopes TEXT NOT NULL DEFAULT '[]',
  removed_fields TEXT NOT NULL DEFAULT '[]',
  cutoff         TEXT,
  before_state  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','done','skipped','failed')),
  records_seen  INTEGER NOT NULL DEFAULT 0,
  records_done  INTEGER NOT NULL DEFAULT 0,
  processed_at  TEXT,
  detail        TEXT,
  PRIMARY KEY (job_id, batch_id)
);
CREATE INDEX IF NOT EXISTS job_targets_status ON job_targets(job_id, status, ord);

-- 隔离区：被隔离批次移入的不可查询副本，受法务保全保护。
CREATE TABLE IF NOT EXISTS vault_batches (
  id            TEXT PRIMARY KEY,
  subject_id    TEXT NOT NULL REFERENCES subjects(id),
  batch_id      TEXT NOT NULL,
  job_id        TEXT,
  reason        TEXT NOT NULL,
  legal_hold    INTEGER NOT NULL DEFAULT 0,
  entry_count   INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL CHECK (state IN ('held','released','purged')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_batches_batch ON vault_batches(batch_id);

CREATE TABLE IF NOT EXISTS vault_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id    TEXT NOT NULL REFERENCES vault_batches(id),
  record_id   INTEGER NOT NULL,
  batch_id    TEXT NOT NULL,
  subject_id  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('held','released','purged')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_entries_vault ON vault_entries(vault_id);

-- 审计流水：追加写，绝不更新/删除。
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  actor_role  TEXT NOT NULL,
  action      TEXT NOT NULL,
  subject_id  TEXT,
  job_id      TEXT,
  batch_id    TEXT,
  snapshot_id TEXT,
  summary     TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_subject ON audit_log(subject_id);
CREATE INDEX IF NOT EXISTS audit_job ON audit_log(job_id);

-- 通知通道：真实发送前先入队，受 dedupe_key 唯一约束保护。
CREATE TABLE IF NOT EXISTS notices (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES subjects(id),
  job_id      TEXT,
  snapshot_id TEXT,
  channel     TEXT NOT NULL,
  template    TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('queued','sent','suppressed','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  sent_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS notices_dedupe ON notices(dedupe_key);

-- 收到的外部授权通知原始报文（用于重复通知验证）。
CREATE TABLE IF NOT EXISTS consent_notices (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL,
  notice_key  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  snapshot_id TEXT,
  received_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS consent_notices_key ON consent_notices(notice_key);
`;

export function openDb(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(SCHEMA);
  return db;
}

const txDepth = new WeakMap();

/** Transaction helper with nesting support (savepoints). */
export function tx(db, fn) {
  const depth = txDepth.get(db) ?? 0;
  const savepoint = `sp_${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    try {
      db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
      if (depth > 0) db.exec(`RELEASE ${savepoint}`);
    } catch {
      /* already rolled back */
    }
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}
