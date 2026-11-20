import test from 'node:test';
import assert from 'node:assert/strict';
import {
  freshDb,
  addSubject,
  consent,
  L,
  count,
  parseJson,
} from './helpers.js';

test('快照不可变：同一 terms 归一化后哈希稳定，条款变化则版本递增且 prevId 成链', () => {
  const db = freshDb();
  const sub = addSubject(db);

  const v1 = consent(db, sub);
  assert.equal(v1.outcome, 'accepted');
  assert.equal(v1.snapshot.version, 1);
  assert.equal(v1.snapshot.prevId, null);
  assert.equal(v1.snapshot.status, 'active');

  // 哈希只取决于条款内容：用途/范围顺序不影响结果。
  const shuffled = L.computeTermsHash({
    status: 'active',
    purposes: ['marketing', 'analytics', 'personalization'],
    scopes: ['location_coarse', 'behavior', 'contact'],
    retentionDays: 180,
  });
  assert.equal(shuffled, v1.snapshot.termsHash, '顺序不应改变条款哈希');

  const v2 = consent(db, sub, {
    purposes: ['analytics', 'marketing'],
    scopes: ['contact', 'behavior'],
    retentionDays: 120,
  });
  assert.equal(v2.snapshot.version, 2);
  assert.equal(v2.snapshot.prevId, v1.snapshot.id);
  assert.notEqual(v2.snapshot.termsHash, v1.snapshot.termsHash);

  // 旧版本行仍原样保留——不可变即不 UPDATE。
  const rows = db.prepare('SELECT * FROM snapshots WHERE subject_id = ? ORDER BY version').all(sub);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].terms_hash, v1.snapshot.termsHash);
  assert.equal(rows[0].retention_days, 180);
  assert.equal(rows[0].prev_id, null);
  assert.equal(rows[1].prev_id, rows[0].id);

  // 已建批次绑定的是创建当时的快照，不会随新版本回写。
  const batch = L.createBatch(db, {
    subjectId: sub,
    purpose: 'analytics',
    scopes: ['behavior'],
    fields: ['behavior'],
    records: [{ behavior: 'click' }],
  });
  L.sealBatch(db, batch.batchId);
  const row = db.prepare('SELECT * FROM batches WHERE id = ?').get(batch.batchId);
  assert.equal(row.snapshot_id, rows[1].id);
  assert.equal(row.snapshot_version, 2);
  assert.equal(row.terms_hash, rows[1].terms_hash);
});

test('快照条款非法时拒绝写入，版本号不跳号', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);

  assert.throws(
    () => L.applyConsentNotice(db, { subjectId: sub, noticeKey: 'BAD-1', purposes: ['analytics'], scopes: [], retentionDays: 30 }),
    /至少需要一个数据范围/,
  );
  assert.throws(
    () => L.applyConsentNotice(db, { subjectId: sub, noticeKey: 'BAD-2', purposes: ['nope'], scopes: ['behavior'], retentionDays: 30 }),
    /未知用途/,
  );
  assert.throws(
    () => L.applyConsentNotice(db, { subjectId: sub, noticeKey: 'BAD-3', purposes: ['analytics'], scopes: ['behavior'], retentionDays: 0 }),
    /保留期限/,
  );
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?', sub), 1);

  const v2 = consent(db, sub, { purposes: ['analytics'], scopes: ['behavior'], retentionDays: 30 });
  assert.equal(v2.snapshot.version, 2);
});

test('有效快照计算：撤回后 effectiveSnapshot 返回撤回版本，历史版本仍可读取', () => {
  const db = freshDb();
  const sub = addSubject(db);
  const v1 = consent(db, sub);
  const rev = L.applyConsentNotice(db, {
    subjectId: sub,
    noticeKey: 'REVOKE-1',
    status: 'revoked',
    purposes: [],
    scopes: [],
    retentionDays: 0,
    reason: '删除请求',
  });
  assert.equal(rev.outcome, 'accepted');
  assert.equal(rev.snapshot.status, 'revoked');
  assert.equal(rev.snapshot.version, 2);
  assert.equal(rev.snapshot.retentionDays, 0);

  const eff = L.snapshotView(L.effectiveSnapshot(db, sub));
  assert.equal(eff.id, rev.snapshot.id);
  assert.equal(eff.status, 'revoked');

  const old = L.snapshotView(L.getSnapshot(db, v1.snapshot.id));
  assert.equal(old.status, 'active');
  assert.deepEqual(old.purposes, ['analytics', 'personalization', 'marketing']);
  assert.equal(parseJson(db.prepare('SELECT purposes FROM snapshots WHERE id = ?').get(v1.snapshot.id).purposes).length, 3);
});
