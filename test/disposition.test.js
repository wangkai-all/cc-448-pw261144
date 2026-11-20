import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addSubject, consent, seedBatch, L, count, auditActions } from './helpers.js';

/**
 * 处置决策与执行。重点断言 records / batches / vault 表的真实行变化，
 * 而不是查询接口的返回条数。
 */

test('用途失权 -> 整批物理删除（records 行真正消失，不是查询过滤）', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  const personal = seedBatch(db, sub, {
    purpose: 'personalization',
    scopes: ['behavior'],
    fields: ['behavior'],
    n: 9,
  });
  const analytics = seedBatch(db, sub, {
    purpose: 'analytics',
    scopes: ['behavior'],
    fields: ['behavior'],
    n: 4,
  });

  const res = consent(db, sub, {
    purposes: ['analytics'],
    scopes: ['behavior', 'contact', 'location_coarse'],
    retentionDays: 180,
  });
  assert.equal(res.outcome, 'accepted');
  assert.ok(res.job);
  assert.equal(res.job.trigger, 'consent_narrowed');
  assert.equal(res.job.action, 'delete');
  assert.equal(res.job.totalBatches, 1, '只处置失权用途的批次');

  const target = res.job.targets[0];
  assert.equal(target.batchId, personal);
  assert.equal(target.action, 'delete');
  assert.equal(target.kind, 'purpose_revoked');

  const run = L.runJob(db, res.job.id);
  assert.equal(run.job.status, 'completed');
  assert.equal(run.job.processedBatches, 1);
  assert.equal(run.job.processedRecords, 9);

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', personal), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', analytics), 4);
  const p = db.prepare('SELECT * FROM batches WHERE id = ?').get(personal);
  assert.equal(p.status, 'deleted');
  assert.equal(p.record_count, 0);
  assert.equal(p.disposed_action, 'delete');
  assert.equal(p.disposed_by_job, res.job.id);

  const actions = auditActions(db, { job_id: res.job.id });
  assert.deepEqual(actions, [
    'disposition.planned',
    'disposition.started',
    'disposition.batch.deleted',
    'disposition.completed',
  ]);
});

test('部分范围失权且为高风险 -> 迁入隔离区，records 迁出、vault 副本保留', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  const batchId = seedBatch(db, sub, {
    purpose: 'analytics',
    scopes: ['contact', 'behavior'],
    fields: ['contact', 'behavior'],
    n: 6,
    record: { contact: '13800002222', behavior: '下单' },
  });

  const res = consent(db, sub, {
    purposes: ['analytics', 'personalization', 'marketing'],
    scopes: ['behavior', 'location_coarse'],
    retentionDays: 180,
  });
  const job = res.job;
  assert.equal(job.action, 'quarantine');
  const target = job.targets.find((t) => t.batchId === batchId);
  assert.equal(target.action, 'quarantine');
  assert.equal(target.kind, 'scope_revoked_sensitive');
  assert.deepEqual(target.removedFields, ['contact']);

  L.runJob(db, job.id);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', batchId), 0);

  const vault = db.prepare('SELECT * FROM vault_batches WHERE batch_id = ?').get(batchId);
  assert.ok(vault);
  assert.equal(vault.state, 'held');
  assert.equal(vault.entry_count, 6);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM vault_entries WHERE vault_id = ?', vault.id), 6);
  const entry = db.prepare('SELECT payload FROM vault_entries WHERE vault_id = ? LIMIT 1').get(vault.id);
  assert.ok(JSON.parse(entry.payload).contact, '隔离副本保留原始字段，供复核');

  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  assert.equal(batch.status, 'quarantined');
  assert.equal(batch.record_count, 0);

  // 查询接口确实读不到（因为物理迁出，不是 WHERE 过滤）
  const visible = L.queryRecords(db, { subjectId: sub });
  assert.equal(visible.length, 0);
  assert.deepEqual(auditActions(db, { job_id: job.id }), [
    'disposition.planned',
    'disposition.started',
    'disposition.batch.quarantined',
    'disposition.completed',
  ]);
});

test('部分范围失权且非高风险 -> 字段降级：payload 抹除字段，其余保留可查', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  const batchId = seedBatch(db, sub, {
    purpose: 'analytics',
    scopes: ['behavior', 'location_coarse'],
    fields: ['behavior', 'city'],
    n: 5,
    record: { behavior: '浏览', city: '杭州市西湖区' },
  });

  const res = consent(db, sub, {
    purposes: ['analytics'],
    scopes: ['behavior', 'contact'],
    retentionDays: 180,
  });
  const target = res.job.targets.find((t) => t.batchId === batchId);
  assert.equal(target.action, 'degrade');
  assert.equal(target.kind, 'scope_revoked_partial');
  assert.deepEqual(target.removedFields, ['city']);

  L.runJob(db, res.job.id);

  const rows = db.prepare('SELECT * FROM records WHERE batch_id = ?').all(batchId);
  assert.equal(rows.length, 5, '降级是就地改写，不删除行');
  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    assert.deepEqual(Object.keys(payload), ['behavior'], 'city 字段已从存储中抹除');
    assert.equal(row.state, 'degraded');
    assert.equal(row.state_job, res.job.id);
    assert.match(row.state_reason, /城市级位置/);
  }
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  assert.equal(batch.status, 'degraded');
  assert.deepEqual(JSON.parse(batch.fields), ['behavior']);
  assert.deepEqual(JSON.parse(batch.scopes), ['behavior']);

  // 仍可查询到，但只含授权字段
  const visible = L.queryRecords(db, { subjectId: sub });
  assert.equal(visible.length, 5);
  assert.deepEqual(visible[0].payload, { behavior: '浏览' });
});

test('保留期缩短 -> 只清除采集时间早于 cutoff 的记录，剩余记录与批次保留', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  const batchId = seedBatch(db, sub, {
    purpose: 'analytics',
    scopes: ['behavior'],
    fields: ['behavior'],
    n: 10,
    capturedDaysAgo: 200,
  });
  // 手工留一条最近采集的记录：cutoff 之后应保留
  db.prepare('UPDATE records SET captured_at = ? WHERE id = (SELECT MAX(id) FROM records WHERE batch_id = ?)').run(
    new Date().toISOString(),
    batchId,
  );

  const res = consent(db, sub, {
    purposes: ['analytics', 'personalization', 'marketing'],
    scopes: ['contact', 'behavior', 'location_coarse'],
    retentionDays: 120,
  });
  const target = res.job.targets.find((t) => t.batchId === batchId);
  assert.equal(res.job.trigger, 'retention_policy');
  assert.equal(target.action, 'delete');
  assert.equal(target.kind, 'retention_shortened');
  assert.match(target.reason, /365|180.*120|清除 9 条/);
  assert.ok(target.cutoff);

  L.runJob(db, res.job.id);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', batchId), 1);
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  assert.equal(batch.status, 'sealed', '保留期清理不等于整批删除');
  assert.equal(batch.retention_days, 120);
  assert.ok(batch.disposed_at);
  assert.ok(
    db.prepare("SELECT 1 FROM audit_log WHERE batch_id = ? AND action = 'disposition.retention.applied'").get(batchId),
  );
});

test('保留期缩短但无超期记录 -> 不生成批次目标，任务直接完成', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  seedBatch(db, sub, { purpose: 'analytics', scopes: ['behavior'], fields: ['behavior'], n: 3 });

  const res = consent(db, sub, {
    purposes: ['analytics', 'personalization', 'marketing'],
    scopes: ['contact', 'behavior', 'location_coarse'],
    retentionDays: 120,
  });
  assert.ok(res.job);
  assert.equal(res.job.totalBatches, 0);
  assert.equal(res.job.status, 'completed');
  assert.equal(res.job.action, 'none');
});

test('授权放宽不生成处置任务，历史数据不受影响', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub, { purposes: ['analytics'], scopes: ['behavior'], retentionDays: 90 });
  const batchId = seedBatch(db, sub, { purpose: 'analytics', scopes: ['behavior'], fields: ['behavior'], n: 2 });

  const res = consent(db, sub, {
    purposes: ['analytics', 'marketing'],
    scopes: ['behavior', 'contact'],
    retentionDays: 90,
  });
  assert.equal(res.outcome, 'accepted');
  assert.equal(res.job, null);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE subject_id = ?', sub), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', batchId), 2);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE subject_id = ? AND action = 'consent.widened'").get(sub));
});

test('处置动作分布 mixed：一个任务内按批次分别删除 / 隔离 / 降级', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  const delId = seedBatch(db, sub, { purpose: 'personalization', scopes: ['behavior'], fields: ['behavior'], n: 2 });
  const quarantineId = seedBatch(db, sub, {
    purpose: 'analytics',
    scopes: ['contact', 'behavior'],
    fields: ['contact', 'behavior'],
    n: 3,
  });
  const degradeId = seedBatch(db, sub, {
    purpose: 'analytics',
    scopes: ['behavior', 'location_coarse'],
    fields: ['behavior', 'city'],
    n: 3,
  });
  const untouchedId = seedBatch(db, sub, { purpose: 'analytics', scopes: ['behavior'], fields: ['behavior'], n: 4 });

  const res = consent(db, sub, {
    purposes: ['analytics'],
    scopes: ['behavior'],
    retentionDays: 180,
  });
  assert.equal(res.job.action, 'mixed');
  assert.equal(res.job.totalBatches, 3);

  L.runJob(db, res.job.id);

  assert.equal(db.prepare('SELECT status FROM batches WHERE id = ?').get(delId).status, 'deleted');
  assert.equal(db.prepare('SELECT status FROM batches WHERE id = ?').get(quarantineId).status, 'quarantined');
  assert.equal(db.prepare('SELECT status FROM batches WHERE id = ?').get(degradeId).status, 'degraded');
  assert.equal(db.prepare('SELECT status FROM batches WHERE id = ?').get(untouchedId).status, 'sealed');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', untouchedId), 4);
  const finished = L.jobView(db, res.job.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.targetsDone, 3);
  assert.equal(finished.processedRecords, 8);
});

test('法务保全的批次跳过处置并写升级审计，任务完成但目标标记 skipped', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  const batchId = seedBatch(db, sub, { purpose: 'personalization', scopes: ['behavior'], fields: ['behavior'], n: 2 });
  db.prepare('UPDATE batches SET legal_hold = 1, hold_reason = ? WHERE id = ?').run('诉讼取证中', batchId);

  const res = consent(db, sub, { purposes: ['analytics'], scopes: ['behavior'], retentionDays: 180 });
  L.runJob(db, res.job.id);

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', batchId), 2, '保全期间不删除');
  const target = L.jobView(db, res.job.id).targets.find((t) => t.batchId === batchId);
  assert.equal(target.status, 'skipped');
  assert.match(target.detail.reason, /法务保全/);
  assert.ok(
    db.prepare("SELECT 1 FROM audit_log WHERE batch_id = ? AND action = 'disposition.skipped_hold'").get(batchId),
  );
});

test('删除批次时若隔离区存在同批副本，未保全副本一并清除（purged）', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  const batchId = seedBatch(db, sub, {
    purpose: 'analytics',
    scopes: ['contact', 'behavior'],
    fields: ['contact', 'behavior'],
    n: 2,
  });
  // 手工造一份已存在的隔离副本
  db.prepare(
    `INSERT INTO vault_batches (id, subject_id, batch_id, job_id, reason, legal_hold, entry_count, state, created_at, updated_at)
     VALUES ('vlt_old', ?, ?, NULL, '旧隔离', 0, 1, 'held', ?, ?)`,
  ).run(sub, batchId, new Date().toISOString(), new Date().toISOString());
  db.prepare(
    `INSERT INTO vault_entries (vault_id, record_id, batch_id, subject_id, payload, state, created_at, updated_at)
     VALUES ('vlt_old', 99999, ?, ?, '{"contact":"x"}', 'held', ?, ?)`,
  ).run(batchId, sub, new Date().toISOString(), new Date().toISOString());

  L.applyConsentNotice(db, {
    subjectId: sub,
    noticeKey: 'FULL-REVOKE',
    status: 'revoked',
    purposes: [],
    scopes: [],
    retentionDays: 0,
  });
  const job = db.prepare("SELECT * FROM jobs WHERE subject_id = ? AND trigger = 'consent_revoked'").get(sub);
  L.runJob(db, job.id);

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', batchId), 0);
  const vault = db.prepare("SELECT * FROM vault_batches WHERE id = 'vlt_old'").get();
  assert.equal(vault.state, 'purged');
  assert.equal(vault.entry_count, 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM vault_entries WHERE vault_id = 'vlt_old'"), 0);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'vault.purged'").get());
});

test('处置任务幂等：同一目标快照重复规划不会生成第二个任务', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  const res = consent(db, sub, { purposes: ['analytics'], scopes: ['behavior'], retentionDays: 180 });
  assert.ok(res.job);

  const from = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(res.job.fromSnapshot.id);
  const to = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(res.job.toSnapshot.id);
  const again = L.planDispositionForSnapshotChange(db, from, to);
  assert.equal(again.id, res.job.id);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE subject_id = ?', sub), 1);
  assert.ok(
    db.prepare("SELECT 1 FROM audit_log WHERE action = 'disposition.deduped' AND job_id = ?").get(res.job.id),
  );
});
