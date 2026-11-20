import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addSubject, consent, seedBatch, L, count } from './helpers.js';

function quarantineOnce() {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  const batchId = seedBatch(db, sub, {
    purpose: 'analytics',
    scopes: ['contact', 'behavior', 'location_coarse'],
    fields: ['contact', 'behavior', 'city'],
    n: 3,
    record: { contact: '13800003333', behavior: '下单', city: '杭州市' },
  });
  const res = consent(db, sub, {
    purposes: ['analytics'],
    scopes: ['behavior', 'location_coarse'],
    retentionDays: 180,
  });
  assert.equal(res.job.targets[0].action, 'quarantine');
  L.runJob(db, res.job.id);
  const vault = db.prepare('SELECT * FROM vault_batches WHERE batch_id = ?').get(batchId);
  return { db, sub, batchId, vault, jobId: res.job.id };
}

test('隔离副本恢复：仅当授权重新覆盖该用途与字段时，写回 records 且只保留授权字段', () => {
  const { db, sub, batchId, vault } = quarantineOnce();
  assert.equal(vault.state, 'held');

  // 当前授权已收回 contact 范围（用途仍在），恢复必须被拒绝
  assert.throws(() => L.releaseVault(db, vault.id), (err) => err.code === 'E_SCOPE_NOT_GRANTED');
  // 重新授权 contact（用途 analytics + 四个范围）
  consent(db, sub, {
    purposes: ['analytics'],
    scopes: ['contact', 'behavior', 'location_coarse'],
    retentionDays: 180,
  });

  const res = L.releaseVault(db, vault.id, { reason: '复核后恢复' });
  assert.equal(res.state, 'released');
  assert.equal(res.restored, 3);

  const rows = db.prepare('SELECT * FROM records WHERE batch_id = ?').all(batchId);
  assert.equal(rows.length, 3);
  assert.deepEqual(Object.keys(JSON.parse(rows[0].payload)).sort(), ['behavior', 'city', 'contact']);
  assert.equal(JSON.parse(rows[0].payload).contact, '13800003333');
  assert.equal(db.prepare('SELECT state FROM vault_batches WHERE id = ?').get(vault.id).state, 'released');
  assert.equal(db.prepare('SELECT status FROM batches WHERE id = ?').get(batchId).status, 'sealed');
  assert.equal(db.prepare('SELECT disposed_action FROM batches WHERE id = ?').get(batchId).disposed_action, 'release');
  assert.equal(L.queryRecords(db, { subjectId: sub }).length, 3);

  // 重复处理被拒绝
  assert.throws(() => L.releaseVault(db, vault.id), /不能重复处理/);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'vault.released' AND batch_id = ?").get(batchId));
});

test('隔离副本恢复：授权仍撤回时拒绝，数据继续不可查', () => {
  const { db, sub, batchId, vault } = quarantineOnce();
  L.applyConsentNotice(db, {
    subjectId: sub,
    noticeKey: 'REVOKE-VAULT',
    status: 'revoked',
    purposes: [],
    scopes: [],
    retentionDays: 0,
  });
  L.runJob(db, db.prepare("SELECT id FROM jobs WHERE trigger = 'consent_revoked'").get().id);
  // 撤回处置会清除未保全副本
  assert.equal(db.prepare('SELECT state FROM vault_batches WHERE id = ?').get(vault.id).state, 'purged');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', batchId), 0);
});

test('隔离副本恢复拒绝时保持 held，不产生部分写入', () => {
  const { db, vault } = quarantineOnce();
  assert.throws(() => L.releaseVault(db, vault.id), (err) => err.code === 'E_SCOPE_NOT_GRANTED');
  assert.equal(db.prepare('SELECT state, entry_count FROM vault_batches WHERE id = ?').get(vault.id).state, 'held');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM vault_entries WHERE vault_id = ?', vault.id), 3);
});

test('隔离副本永久清除：entries 物理删除，批次保持隔离状态但记录清零', () => {
  const { db, batchId, vault } = quarantineOnce();
  const res = L.releaseVault(db, vault.id, { dispose: 'purge', reason: '确认无需保留' });
  assert.equal(res.state, 'purged');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM vault_entries WHERE vault_id = ?', vault.id), 0);
  const v = db.prepare('SELECT * FROM vault_batches WHERE id = ?').get(vault.id);
  assert.equal(v.entry_count, 0);
  assert.equal(v.state, 'purged');
  assert.equal(db.prepare('SELECT disposed_action FROM batches WHERE id = ?').get(batchId).disposed_action, 'delete');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', batchId), 0);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'vault.purged'").get());
});

test('法务保全的隔离副本不能恢复或清除', () => {
  const { db, vault } = quarantineOnce();
  db.prepare('UPDATE vault_batches SET legal_hold = 1 WHERE id = ?').run(vault.id);
  assert.throws(() => L.releaseVault(db, vault.id), (err) => err.code === 'E_LEGAL_HOLD');
  assert.throws(() => L.releaseVault(db, vault.id, { dispose: 'purge' }), (err) => err.code === 'E_LEGAL_HOLD');
});
