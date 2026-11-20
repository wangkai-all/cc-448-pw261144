import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addSubject, consent, seedBatch, L, count } from './helpers.js';

test('批次绑定创建时的快照，记录按字段映射落库', () => {
  const db = freshDb();
  const sub = addSubject(db);
  const v1 = consent(db, sub);
  const batchId = seedBatch(db, sub, {
    purpose: 'analytics',
    scopes: ['behavior', 'location_coarse'],
    fields: ['behavior', 'city'],
    n: 7,
  });

  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  assert.equal(batch.snapshot_id, v1.snapshot.id);
  assert.equal(batch.snapshot_version, 1);
  assert.equal(batch.terms_hash, v1.snapshot.termsHash);
  assert.equal(batch.status, 'sealed');
  assert.equal(batch.record_count, 7);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', batchId), 7);

  const rows = L.queryRecords(db, { subjectId: sub });
  assert.equal(rows.length, 7);
  assert.deepEqual(Object.keys(rows[0].payload).sort(), ['behavior', 'city']);
});

test('撤回后新采集被阻断：零记录入库，返回 CONSENT_REVOKED 并写审计', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  seedBatch(db, sub, { purpose: 'analytics', scopes: ['behavior'], fields: ['behavior'], n: 3 });
  L.applyConsentNotice(db, {
    subjectId: sub,
    noticeKey: 'REVOKE-INGEST',
    status: 'revoked',
    purposes: [],
    scopes: [],
    retentionDays: 0,
  });

  const res = L.createBatch(db, {
    subjectId: sub,
    purpose: 'analytics',
    scopes: ['behavior'],
    fields: ['behavior'],
    records: [{ behavior: '撤回后写入尝试' }],
  });
  assert.equal(res.status, 'blocked');
  assert.equal(res.code, 'CONSENT_REVOKED');

  const blocked = db.prepare('SELECT * FROM batches WHERE id = ?').get(res.batchId);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.block_code, 'CONSENT_REVOKED');
  assert.equal(blocked.record_count, 0);
  assert.equal(blocked.compliance, 'revoked');
  assert.equal(
    count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', res.batchId),
    0,
    '阻断批次不得写入任何记录',
  );

  const audit = db
    .prepare("SELECT summary FROM audit_log WHERE batch_id = ? AND action = 'ingest.blocked'")
    .get(res.batchId);
  assert.ok(audit, '阻断应写审计');
  assert.match(audit.summary, /抑制|阻断|拒绝/);
});

test('超授权采集被阻断：用途/范围超出授权、保留期超过上限', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub, { purposes: ['analytics'], scopes: ['behavior'], retentionDays: 90 });

  const wrongPurpose = L.createBatch(db, {
    subjectId: sub,
    purpose: 'marketing',
    scopes: ['behavior'],
    fields: ['behavior'],
    records: [{ behavior: 'x' }],
  });
  assert.equal(wrongPurpose.status, 'blocked');
  assert.equal(wrongPurpose.code, 'SCOPE_NOT_GRANTED');
  assert.match(wrongPurpose.reason, /用途/);

  const wrongScope = L.createBatch(db, {
    subjectId: sub,
    purpose: 'analytics',
    scopes: ['behavior', 'contact'],
    fields: ['behavior', 'contact'],
    records: [{ behavior: 'x', contact: '13800000000' }],
  });
  assert.equal(wrongScope.status, 'blocked');
  assert.equal(wrongScope.code, 'SCOPE_NOT_GRANTED');
  assert.match(wrongScope.reason, /联系方式/);

  const overRetention = L.createBatch(db, {
    subjectId: sub,
    purpose: 'analytics',
    scopes: ['behavior'],
    fields: ['behavior'],
    retentionDays: 365,
    records: [{ behavior: 'x' }],
  });
  assert.equal(overRetention.status, 'blocked');
  assert.equal(overRetention.code, 'RETENTION_EXCEEDS');
  assert.match(overRetention.reason, /365.*90/);

  for (const id of [wrongPurpose.batchId, wrongScope.batchId, overRetention.batchId]) {
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', id), 0);
  }
  // 三个尝试都留下可追溯的阻断批次
  assert.equal(
    count(db, "SELECT COUNT(*) AS n FROM batches WHERE subject_id = ? AND status = 'blocked'", sub),
    3,
  );

  // 未指定保留期时跟随授权上限，可以正常入库。
  const ok = L.createBatch(db, {
    subjectId: sub,
    purpose: 'analytics',
    scopes: ['behavior'],
    fields: ['behavior'],
    records: [{ behavior: 'x' }],
  });
  assert.equal(ok.status, 'collecting');
  assert.equal(db.prepare('SELECT retention_days FROM batches WHERE id = ?').get(ok.batchId).retention_days, 90);
});

test('字段必须落在声明范围内，否则拒绝创建', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  assert.throws(
    () =>
      L.createBatch(db, {
        subjectId: sub,
        purpose: 'analytics',
        scopes: ['location_coarse'],
        fields: ['lat'],
        records: [{ lat: 1 }],
      }),
    /不属于所选范围/,
  );
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM batches WHERE subject_id = ?', sub), 0);
});

test('采集过程中撤回：封存时转阻断；已封存批次拒绝补写', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  const res = L.createBatch(db, {
    subjectId: sub,
    purpose: 'analytics',
    scopes: ['behavior'],
    fields: ['behavior'],
    records: [{ behavior: 'a' }],
  });
  assert.equal(res.status, 'collecting');

  L.applyConsentNotice(db, {
    subjectId: sub,
    noticeKey: 'MID-REVOKE',
    status: 'revoked',
    purposes: [],
    scopes: [],
    retentionDays: 0,
  });

  const seal = L.sealBatch(db, res.batchId);
  assert.equal(seal.status, 'blocked');
  assert.equal(seal.code, 'CONSENT_REVOKED');
  const row = db.prepare('SELECT status FROM batches WHERE id = ?').get(res.batchId);
  assert.equal(row.status, 'blocked');

  // 已阻断/已删除批次再补写也要被拒绝
  assert.throws(() => L.appendRecords(db, res.batchId, [{ behavior: '补写' }]), /不能再写入记录/);
});

test('封存时发现批次超出当前授权：标记 flagged 并写审计（数据不删，由处置任务处理）', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  const res = L.createBatch(db, {
    subjectId: sub,
    purpose: 'personalization',
    scopes: ['contact', 'behavior'],
    fields: ['contact', 'behavior'],
    records: [{ contact: '13800000001', behavior: 'browse' }],
  });

  const v2 = consent(db, sub, {
    purposes: ['analytics'],
    scopes: ['behavior'],
    retentionDays: 180,
  });
  L.sealBatch(db, res.batchId);

  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(res.batchId);
  assert.equal(batch.status, 'sealed', '封存不直接删数据');
  assert.equal(batch.flagged_by_snapshot, v2.snapshot.id);
  assert.ok(batch.flagged_at);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', res.batchId), 1);
  assert.ok(
    db.prepare("SELECT 1 FROM audit_log WHERE batch_id = ? AND action = 'batch.flagged'").get(res.batchId),
  );

  // 处置任务会接管（用途整体失权 -> delete）
  const job = db.prepare('SELECT * FROM jobs WHERE subject_id = ? ORDER BY created_at DESC').get(sub);
  assert.ok(job);
  assert.equal(job.trigger, 'consent_narrowed');
});
