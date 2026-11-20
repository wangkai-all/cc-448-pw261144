import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addSubject, consent, seedBatch, L, count, addDays, nowIso } from './helpers.js';

test('保留期清理：到期批次物理删除，未到期批次保留，保全批次跳过', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub, { retentionDays: 30 });

  const expired = seedBatch(db, sub, {
    purpose: 'analytics',
    scopes: ['behavior'],
    fields: ['behavior'],
    n: 4,
    capturedDaysAgo: 60,
  });
  const fresh = seedBatch(db, sub, {
    purpose: 'analytics',
    scopes: ['behavior'],
    fields: ['behavior'],
    n: 3,
    capturedDaysAgo: 5,
  });
  const held = seedBatch(db, sub, {
    purpose: 'analytics',
    scopes: ['behavior'],
    fields: ['behavior'],
    n: 2,
    capturedDaysAgo: 60,
  });
  db.prepare('UPDATE batches SET legal_hold = 1 WHERE id = ?').run(held);

  const preview = L.sweepRetention(db, { dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.due, 1);
  assert.deepEqual(preview.batches, [expired]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', expired), 4, 'dry run 不动数据');

  const res = L.sweepRetention(db);
  assert.equal(res.due, 1);
  assert.equal(res.removedRecords, 4);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', expired), 0);
  assert.equal(db.prepare('SELECT status FROM batches WHERE id = ?').get(expired).status, 'deleted');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', fresh), 3);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', held), 2);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'retention.swept' AND batch_id = ?").get(expired));
});

test('保留期清理按 sealed_at 计算，未封存的 collecting 批次不清理', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub, { retentionDays: 1 });
  const res = L.createBatch(db, {
    subjectId: sub,
    purpose: 'analytics',
    scopes: ['behavior'],
    fields: ['behavior'],
    records: [{ behavior: 'a' }],
  });
  db.prepare('UPDATE batches SET started_at = ? WHERE id = ?').run(addDays(nowIso(), -10), res.batchId);
  assert.equal(L.sweepRetention(db).due, 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', res.batchId), 1);
});

test('保留期清理同时清除同批隔离副本（未保全）', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub, { retentionDays: 30 });
  const batchId = seedBatch(db, sub, {
    purpose: 'analytics',
    scopes: ['behavior'],
    fields: ['behavior'],
    n: 2,
    capturedDaysAgo: 60,
  });
  db.prepare(
    `INSERT INTO vault_batches (id, subject_id, batch_id, job_id, reason, legal_hold, entry_count, state, created_at, updated_at)
     VALUES ('vlt_r', ?, ?, NULL, '旧隔离', 0, 2, 'held', ?, ?)`,
  ).run(sub, batchId, nowIso(), nowIso());
  db.prepare(
    `INSERT INTO vault_entries (vault_id, record_id, batch_id, subject_id, payload, state, created_at, updated_at)
     VALUES ('vlt_r', 1, ?, ?, '{}', 'held', ?, ?)`,
  ).run(batchId, sub, nowIso(), nowIso());

  L.sweepRetention(db);
  assert.equal(db.prepare("SELECT state FROM vault_batches WHERE id = 'vlt_r'").get().state, 'purged');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM vault_entries WHERE vault_id = 'vlt_r'"), 0);
});
