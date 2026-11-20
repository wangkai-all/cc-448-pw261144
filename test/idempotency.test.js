import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addSubject, consent, seedBatch, L, count, auditActions } from './helpers.js';

/**
 * 重复通知的三种形态：同 noticeKey 重放、同条款换 key、快照已落库但规划前崩溃后重规划。
 * 以及通知出队的去重。
 */

test('同一 noticeKey 重放：返回首次结果，不新增快照 / 任务 / 通知', () => {
  const db = freshDb();
  const sub = addSubject(db);
  const first = consent(db, sub, { noticeKey: 'DUP-KEY' });
  const snapshots0 = count(db, 'SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?', sub);
  const jobs0 = count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE subject_id = ?', sub);
  const notices0 = count(db, 'SELECT COUNT(*) AS n FROM notices WHERE subject_id = ?', sub);

  const replay = L.applyConsentNotice(db, {
    subjectId: sub,
    noticeKey: 'DUP-KEY',
    purposes: ['analytics'],
    scopes: ['behavior'],
    retentionDays: 30,
    reason: '重放（内容不同也不应生效）',
  });

  assert.equal(replay.outcome, 'duplicate_notice');
  assert.equal(replay.job, null);
  assert.equal(replay.snapshot.id, first.snapshot.id);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?', sub), snapshots0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE subject_id = ?', sub), jobs0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM notices WHERE subject_id = ?', sub), notices0);
  assert.equal(L.effectiveSnapshot(db, sub).terms_hash, first.snapshot.termsHash, '旧条款仍是有效版本');
});

test('同条款换 noticeKey：识别为 duplicate_terms，不生成新版本，通知按主体+条款去重', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub, { noticeKey: 'TERMS-A' });

  const res = L.applyConsentNotice(db, {
    subjectId: sub,
    noticeKey: 'TERMS-B',
    // 顺序不同、写法相同 -> 归一化后是同一份条款
    purposes: ['marketing', 'analytics', 'personalization'],
    scopes: ['location_coarse', 'contact', 'behavior'],
    retentionDays: 180,
    reason: '换 key 重发',
  });
  assert.equal(res.outcome, 'duplicate_terms');
  assert.equal(res.job, null);
  assert.equal(res.snapshot.version, 1);
  assert.equal(res.notificationSuppressed, true, '同一主体同一条款的重复通知不再下发');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?', sub), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE subject_id = ?', sub), 0);
  assert.equal(
    count(db, "SELECT COUNT(*) AS n FROM notices WHERE dedupe_key LIKE 'notice:dup:%'"),
    1,
  );
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'consent.notice.duplicate'").get());

  // 换回原 key 仍走 notice 级去重
  const again = L.applyConsentNotice(db, {
    subjectId: sub,
    noticeKey: 'TERMS-A',
    purposes: ['analytics', 'personalization', 'marketing'],
    scopes: ['contact', 'behavior', 'location_coarse'],
    retentionDays: 180,
  });
  assert.equal(again.outcome, 'duplicate_notice');
});

test('不同主体不能共用 noticeKey：串号通知被拒绝，不会静默当作重复通知吞掉', () => {
  const db = freshDb();
  const a = addSubject(db, 'sub_a');
  const b = addSubject(db, 'sub_b');
  const ra = L.applyConsentNotice(db, {
    subjectId: a,
    noticeKey: 'SHARED-KEY',
    purposes: ['analytics'],
    scopes: ['behavior'],
    retentionDays: 30,
  });
  assert.equal(ra.outcome, 'accepted');
  assert.throws(
    () =>
      L.applyConsentNotice(db, {
        subjectId: b,
        noticeKey: 'SHARED-KEY',
        purposes: ['analytics'],
        scopes: ['behavior'],
        retentionDays: 30,
      }),
    (err) => err.code === 'E_NOTICE_SUBJECT_CONFLICT' && err.status === 409,
    '同一 noticeKey 指向另一个主体必须报冲突',
  );
  // 拒绝是事务外的，不会给 b 留下任何快照
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?', b), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?', a), 1);

  // 换一个唯一 key 后 b 正常受理
  const rb = L.applyConsentNotice(db, {
    subjectId: b,
    noticeKey: 'B-KEY-1',
    purposes: ['analytics'],
    scopes: ['behavior'],
    retentionDays: 30,
  });
  assert.equal(rb.outcome, 'accepted');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?', b), 1);
});

test('崩溃后重复规划：同一目标快照只命中已有任务，并留下 deduped 审计', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  seedBatch(db, sub, { purpose: 'personalization', scopes: ['behavior'], fields: ['behavior'], n: 3 });

  const res = consent(db, sub, { purposes: ['analytics'], scopes: ['behavior'], retentionDays: 180 });
  const jobId = res.job.id;
  const { fromSnapshot, toSnapshot } = res.job;
  const from = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(fromSnapshot.id);
  const to = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(toSnapshot.id);

  for (let i = 0; i < 3; i += 1) {
    const again = L.planDispositionForSnapshotChange(db, from, to);
    assert.equal(again.id, jobId);
  }
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE subject_id = ?', sub), 1);
  assert.equal(
    count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'disposition.deduped' AND job_id = ?", jobId),
    3,
  );
  assert.equal(
    count(db, 'SELECT COUNT(*) AS n FROM job_targets WHERE job_id = ?', jobId),
    1,
    '目标清单不会重复插入',
  );
});

test('通知去重：同一 dedupe_key 只入队一次，flush 后不会重复下发；重复通知被抑制', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  seedBatch(db, sub, { purpose: 'personalization', scopes: ['behavior'], fields: ['behavior'], n: 2 });
  const res = consent(db, sub, { purposes: ['analytics'], scopes: ['behavior'], retentionDays: 180 });
  const jobNoticeKey = `notice:job:${res.job.id}`;

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM notices WHERE dedupe_key = ?', jobNoticeKey), 1);
  const first = L.flushNotices(db);
  assert.equal(first.sent, 1);
  const second = L.flushNotices(db);
  assert.equal(second.sent, 0, '已发送的通知不会再次出队');
  assert.equal(
    count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'notice.sent'"),
    1,
  );

  // 重放通知不会产生第二条待发通知
  L.applyConsentNotice(db, {
    subjectId: sub,
    noticeKey: 'NOTICE-REPLAY-1',
    purposes: ['analytics'],
    scopes: ['behavior'],
    retentionDays: 180,
  });
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM notices WHERE dedupe_key = ?', jobNoticeKey), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM notices WHERE status = 'queued'"), 0);
});

test('处置执行器分块推进：chunkSize 控制每个事务处理的批次数，进度落库', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  for (let i = 0; i < 5; i += 1) {
    seedBatch(db, sub, { purpose: 'personalization', scopes: ['behavior'], fields: ['behavior'], n: 2 });
  }
  const res = consent(db, sub, { purposes: ['analytics'], scopes: ['behavior'], retentionDays: 180 });
  assert.equal(res.job.totalBatches, 5);

  const r1 = L.runJob(db, res.job.id, { chunkSize: 2, maxChunks: 1 });
  assert.equal(r1.ran, 2);
  assert.equal(r1.job.status, 'running');
  assert.equal(r1.job.processedBatches, 2);
  assert.equal(r1.job.processedRecords, 4);
  assert.equal(r1.job.targets.filter((t) => t.status === 'done').length, 2);
  assert.equal(r1.job.targets.filter((t) => t.status === 'pending').length, 3);

  const r2 = L.runJob(db, res.job.id, { chunkSize: 2, maxChunks: 1 });
  assert.equal(r2.ran, 2);
  assert.equal(r2.job.processedBatches, 4);
  assert.equal(r2.job.status, 'running');

  const r3 = L.runJob(db, res.job.id, { chunkSize: 2 });
  assert.equal(r3.job.status, 'completed');
  assert.equal(r3.job.processedBatches, 5);
  assert.equal(r3.job.processedRecords, 10);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE subject_id = ?', sub), 0);
  assert.equal(
    count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'disposition.completed' AND job_id = ?", res.job.id),
    1,
  );
});

test('执行中断 -> checkpoint 落库 -> 显式恢复从下一个目标继续，已完成目标不重复处理', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  for (let i = 0; i < 4; i += 1) {
    seedBatch(db, sub, { purpose: 'personalization', scopes: ['behavior'], fields: ['behavior'], n: 3 });
  }
  const res = consent(db, sub, { purposes: ['analytics'], scopes: ['behavior'], retentionDays: 180 });
  const jobId = res.job.id;

  const r1 = L.runJob(db, jobId, {
    chunkSize: 1,
    failAfter: 1,
    interruptMessage: '模拟进程退出',
  });
  assert.equal(r1.error, '模拟进程退出');
  assert.equal(r1.job.status, 'paused');
  assert.equal(r1.job.processedBatches, 1);
  assert.equal(r1.job.checkpoint.nextOrd, 1);
  assert.equal(r1.job.checkpoint.processedBatches, 1);

  const doneTarget = r1.job.targets.find((t) => t.status === 'done');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', doneTarget.batchId), 0);

  // 暂停状态下不允许隐式继续
  assert.throws(() => L.runJob(db, jobId), /已暂停/);

  const r2 = L.runJob(db, jobId, { chunkSize: 10, resume: true });
  assert.equal(r2.ran, 3, '恢复后只处理剩余的 3 个批次');
  assert.equal(r2.job.status, 'completed');
  assert.equal(r2.job.processedBatches, 4);
  assert.equal(r2.job.attempts, 2);

  const seq = auditActions(db, { job_id: jobId });
  assert.deepEqual(
    seq.filter((a) => a.startsWith('disposition.')),
    [
      'disposition.planned',
      'disposition.started',
      'disposition.batch.deleted',
      'disposition.paused',
      'disposition.started',
      'disposition.batch.deleted',
      'disposition.batch.deleted',
      'disposition.batch.deleted',
      'disposition.completed',
    ],
  );
});

test('批次级故障：目标标记 failed，其他目标已提交；retry 只重置失败目标', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  const ids = [0, 1, 2].map(() =>
    seedBatch(db, sub, { purpose: 'personalization', scopes: ['behavior'], fields: ['behavior'], n: 2 }),
  );
  const res = consent(db, sub, { purposes: ['analytics'], scopes: ['behavior'], retentionDays: 180 });
  const jobId = res.job.id;
  const failing = L.jobView(db, jobId).targets[1].batchId;

  const r1 = L.runJob(db, jobId, { chunkSize: 3, failOnBatch: failing });
  assert.equal(r1.job.status, 'paused');
  assert.match(r1.job.lastError, /注入故障/);
  const failed = r1.job.targets.find((t) => t.batchId === failing);
  assert.equal(failed.status, 'pending', '故障目标仍为 pending，不丢失');
  assert.equal(r1.job.targets.filter((t) => t.status === 'done').length, 1);

  const retried = L.retryJob(db, jobId);
  assert.equal(retried.status, 'pending');
  const r2 = L.resumeJob(db, jobId, { chunkSize: 5 });
  assert.equal(r2.job.status, 'completed');
  assert.equal(r2.job.processedBatches, 3);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE subject_id = ?', sub), 0);
  assert.deepEqual(
    ids.map((id) => db.prepare('SELECT status FROM batches WHERE id = ?').get(id).status),
    ['deleted', 'deleted', 'deleted'],
  );
});

test('执行失败可重试：抛错的目标标记 failed，retry 重置后再次执行成功', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  seedBatch(db, sub, { purpose: 'personalization', scopes: ['behavior'], fields: ['behavior'], n: 2 });
  const res = consent(db, sub, { purposes: ['analytics'], scopes: ['behavior'], retentionDays: 180 });
  const jobId = res.job.id;
  const batchId = res.job.targets[0].batchId;

  // 用触发器制造一次真实写入失败
  db.exec(
    `CREATE TRIGGER fail_delete BEFORE DELETE ON records WHEN OLD.batch_id = '${batchId}'
     BEGIN SELECT RAISE(ABORT, '模拟存储故障'); END;`,
  );
  const r1 = L.runJob(db, jobId, { chunkSize: 5 });
  assert.equal(r1.job.status, 'paused');
  assert.match(r1.job.lastError, /模拟存储故障/);
  assert.equal(L.jobView(db, jobId).targets[0].status, 'failed');
  assert.equal(
    count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', batchId),
    2,
    '失败事务未部分提交',
  );

  db.exec('DROP TRIGGER fail_delete');
  const retried = L.retryJob(db, jobId);
  assert.equal(retried.targets[0].status, 'pending');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'disposition.retried' AND job_id = ?").get(jobId));

  const r2 = L.resumeJob(db, jobId, { chunkSize: 5 });
  assert.equal(r2.job.status, 'completed');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', batchId), 0);
  assert.equal(L.jobView(db, jobId).attempts, 2);
});

test('人工暂停与恢复：pauseJob 后 resumeJob 继续，重复 pause 报状态错误', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  for (let i = 0; i < 3; i += 1) {
    seedBatch(db, sub, { purpose: 'personalization', scopes: ['behavior'], fields: ['behavior'], n: 1 });
  }
  const res = consent(db, sub, { purposes: ['analytics'], scopes: ['behavior'], retentionDays: 180 });
  const jobId = res.job.id;

  L.runJob(db, jobId, { chunkSize: 1, maxChunks: 1 });
  const paused = L.pauseJob(db, jobId, '等待合规复核');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.lastError, '等待合规复核');
  assert.throws(() => L.pauseJob(db, jobId), /无法暂停/);

  const done = L.resumeJob(db, jobId, { chunkSize: 10 });
  assert.equal(done.job.status, 'completed');
  assert.equal(done.job.processedBatches, 3);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'disposition.paused' AND job_id = ?").get(jobId));
});

test('已完成任务再次执行是 no-op（不重复删除、不累加计数）', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  seedBatch(db, sub, { purpose: 'personalization', scopes: ['behavior'], fields: ['behavior'], n: 2 });
  const res = consent(db, sub, { purposes: ['analytics'], scopes: ['behavior'], retentionDays: 180 });
  L.runJob(db, res.job.id);
  const before = count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'disposition.completed'");
  const again = L.runJob(db, res.job.id);
  assert.equal(again.alreadyComplete, true);
  assert.equal(again.ran, 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'disposition.completed'"), before);
});

test('撤回后不能再接受同主体旧条款的补发通知产生新任务（版本链仍单调）', () => {
  const db = freshDb();
  const sub = addSubject(db);
  consent(db, sub);
  seedBatch(db, sub, { purpose: 'personalization', scopes: ['behavior'], fields: ['behavior'], n: 2 });
  L.applyConsentNotice(db, {
    subjectId: sub,
    noticeKey: 'REVOKE-X',
    status: 'revoked',
    purposes: [],
    scopes: [],
    retentionDays: 0,
  });
  const reGrant = L.applyConsentNotice(db, {
    subjectId: sub,
    noticeKey: 'REGRANT-X',
    purposes: ['analytics'],
    scopes: ['behavior'],
    retentionDays: 30,
  });
  assert.equal(reGrant.outcome, 'accepted');
  assert.equal(reGrant.snapshot.version, 3);
  assert.equal(reGrant.snapshot.status, 'active');
  const versions = db
    .prepare('SELECT version, status FROM snapshots WHERE subject_id = ? ORDER BY version')
    .all(sub)
    .map((r) => `${r.version}:${r.status}`);
  assert.deepEqual(versions, ['1:active', '2:revoked', '3:active']);
});
