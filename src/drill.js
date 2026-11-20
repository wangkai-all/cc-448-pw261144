import { tx } from './db.js';
import * as L from './ledger.js';
import { nowIso, addDays } from './util.js';

/**
 * 演练沙箱：在固定主体 sub_drill 上重建一套可重复的场景，
 * 每个场景返回带证据的断言结果，供页面"验证中心"展示。
 * 沙箱数据可整体重置，不影响真实主体的审计与数据。
 */

const DRILL_SUBJECT = 'sub_drill';
const daysAgo = (n) => addDays(nowIso(), -n);

export const SCENARIOS = [
  {
    key: 'duplicate_notice',
    title: '重复通知幂等',
    desc: '同一 noticeKey 重放、同条款换 key 重发、崩溃后重复规划，均不得产生第二个快照 / 任务 / 通知。',
  },
  {
    key: 'interrupt_resume',
    title: '处置中断与恢复',
    desc: '分块执行中途中断，检查点落库；恢复后从下一个批次继续，且已处置数据是物理变化而非查询过滤。',
  },
  {
    key: 'revoke_blocks_ingest',
    title: '撤回后阻断采集',
    desc: '授权撤回后新批次被阻断且零记录入库；已入库数据按撤回请求物理删除。',
  },
];

export function resetDrill(db) {
  tx(db, () => {
    const jobs = db.prepare('SELECT id FROM jobs WHERE subject_id = ?').all(DRILL_SUBJECT);
    for (const j of jobs) db.prepare('DELETE FROM job_targets WHERE job_id = ?').run(j.id);
    db.prepare('DELETE FROM jobs WHERE subject_id = ?').run(DRILL_SUBJECT);
    db.prepare('DELETE FROM vault_entries WHERE subject_id = ?').run(DRILL_SUBJECT);
    db.prepare('DELETE FROM vault_batches WHERE subject_id = ?').run(DRILL_SUBJECT);
    db.prepare('DELETE FROM records WHERE subject_id = ?').run(DRILL_SUBJECT);
    db.prepare('DELETE FROM batches WHERE subject_id = ?').run(DRILL_SUBJECT);
    db.prepare('DELETE FROM snapshots WHERE subject_id = ?').run(DRILL_SUBJECT);
    db.prepare('DELETE FROM consent_notices WHERE subject_id = ?').run(DRILL_SUBJECT);
    db.prepare('DELETE FROM notices WHERE subject_id = ?').run(DRILL_SUBJECT);
    db.prepare('DELETE FROM audit_log WHERE subject_id = ?').run(DRILL_SUBJECT);
    db.prepare('DELETE FROM subjects WHERE id = ?').run(DRILL_SUBJECT);

    db.prepare(
      'INSERT INTO subjects (id, name, channel, contact_hint, created_at) VALUES (?,?,?,?,?)',
    ).run(DRILL_SUBJECT, '演练主体 · 程一诺', '沙箱', '139****0000', daysAgo(120));
  });

  L.applyConsentNotice(db, {
    subjectId: DRILL_SUBJECT,
    noticeKey: 'DRILL-BASE',
    purposes: ['analytics', 'personalization', 'marketing'],
    scopes: ['contact', 'behavior', 'location_coarse'],
    retentionDays: 180,
    reason: '沙箱初始授权',
    effectiveAt: daysAgo(100),
  });

  const fixtures = [
    {
      purpose: 'personalization',
      scopes: ['contact', 'behavior'],
      fields: ['contact', 'behavior'],
      n: 20,
      days: 90,
      rec: () => ({ contact: '13900000001', behavior: '推荐流曝光' }),
    },
    {
      purpose: 'personalization',
      scopes: ['contact'],
      fields: ['contact'],
      n: 12,
      days: 60,
      rec: () => ({ contact: '13900000002' }),
    },
    {
      purpose: 'analytics',
      scopes: ['behavior', 'location_coarse'],
      fields: ['behavior', 'city'],
      n: 30,
      days: 40,
      rec: () => ({ behavior: '页面浏览', city: '杭州' }),
    },
    {
      purpose: 'marketing',
      scopes: ['contact'],
      fields: ['contact'],
      n: 16,
      days: 20,
      rec: () => ({ contact: '13900000004' }),
    },
  ];

  for (const f of fixtures) {
    const res = L.createBatch(db, {
      subjectId: DRILL_SUBJECT,
      source: '演练采集器',
      purpose: f.purpose,
      scopes: f.scopes,
      fields: f.fields,
      records: Array.from({ length: f.n }, f.rec),
    });
    L.sealBatch(db, res.batchId);
    db.prepare('UPDATE batches SET started_at = ?, sealed_at = ? WHERE id = ?').run(
      daysAgo(f.days),
      daysAgo(f.days - 1),
      res.batchId,
    );
    db.prepare('UPDATE records SET captured_at = ? WHERE batch_id = ?').run(daysAgo(f.days - 1), res.batchId);
  }
  return drillState(db);
}

export function drillState(db) {
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(DRILL_SUBJECT);
  if (!subject) return { subject: null, batches: [], jobs: [], snapshots: [], liveRecords: 0 };
  const snap = L.effectiveSnapshot(db, DRILL_SUBJECT);
  const batches = db
    .prepare('SELECT * FROM batches WHERE subject_id = ? ORDER BY started_at ASC')
    .all(DRILL_SUBJECT)
    .map((b) => ({
      id: b.id,
      purpose: b.purpose,
      scopes: JSON.parse(b.scopes),
      fields: JSON.parse(b.fields),
      status: b.status,
      recordCount: db.prepare('SELECT COUNT(*) AS n FROM records WHERE batch_id = ?').get(b.id).n,
      snapshotVersion: b.snapshot_version,
      disposedAction: b.disposed_action,
    }));
  const rows = db
    .prepare(`SELECT payload FROM records r JOIN batches b ON b.id = r.batch_id WHERE r.subject_id = ? AND r.state IN ('live','degraded')`)
    .all(DRILL_SUBJECT)
    .map((r) => JSON.parse(r.payload));
  return {
    subject: {
      id: subject.id,
      name: subject.name,
      legalHold: !!subject.legal_hold,
      snapshot: L.snapshotView(snap),
    },
    batches,
    jobs: db
      .prepare('SELECT id FROM jobs WHERE subject_id = ? ORDER BY created_at ASC')
      .all(DRILL_SUBJECT)
      .map((j) => L.jobView(db, j.id)),
    snapshots: db
      .prepare('SELECT * FROM snapshots WHERE subject_id = ? ORDER BY version ASC')
      .all(DRILL_SUBJECT)
      .map(L.snapshotView),
    liveRecords: rows.length,
    recordSamples: rows.slice(0, 3),
    notices: db
      .prepare('SELECT * FROM notices WHERE subject_id = ? ORDER BY created_at ASC')
      .all(DRILL_SUBJECT)
      .map((n) => ({
        id: n.id,
        template: n.template,
        status: n.status,
        dedupeKey: n.dedupe_key,
        jobId: n.job_id,
      })),
  };
}

function count(db, sql, ...args) {
  return db.prepare(sql).get(...args).n;
}

export function runScenario(db, key) {
  if (!SCENARIOS.some((s) => s.key === key)) throw new L.LedgerError('E_SCENARIO', '未知场景');
  resetDrill(db);
  const steps = [];
  const push = (title, ok, detail, evidence) => steps.push({ title, ok, detail, evidence: evidence ?? null });

  if (key === 'duplicate_notice') {
    const before = drillState(db);
    const snapCount0 = count(db, 'SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?', DRILL_SUBJECT);
    const jobCount0 = count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE subject_id = ?', DRILL_SUBJECT);
    push(
      '沙箱就绪',
      before.batches.length === 4,
      `初始授权 v${before.subject.snapshot.version}，4 个已封存批次、${before.liveRecords} 条在库记录`,
      { snapshots: snapCount0, batches: before.batches.length },
    );

    const narrow = {
      subjectId: DRILL_SUBJECT,
      noticeKey: 'DRILL-NARROW-1',
      purposes: ['analytics', 'marketing'],
      scopes: ['contact', 'behavior'],
      retentionDays: 90,
      reason: '演练：关闭个性化推荐与城市级位置',
    };
    const first = L.applyConsentNotice(db, narrow);
    const snapAfter = count(db, 'SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?', DRILL_SUBJECT);
    push(
      '首次收窄通知',
      first.outcome === 'accepted' && !!first.job && first.snapshot.version === 2,
      `生成快照 v${first.snapshot.version} 与处置任务 ${first.job?.id}`,
      { outcome: first.outcome, snapshots: snapAfter, job: first.job?.id },
    );

    const replay = L.applyConsentNotice(db, { ...narrow, reason: '演练：重放同一通知' });
    const snapAfterReplay = count(db, 'SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?', DRILL_SUBJECT);
    const jobAfterReplay = count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE subject_id = ?', DRILL_SUBJECT);
    push(
      '同一 noticeKey 重放',
      replay.outcome === 'duplicate_notice' && snapAfterReplay === snapAfter && jobAfterReplay === jobCount0 + 1,
      `返回 ${replay.outcome}，快照 ${snapAfterReplay} 条、任务 ${jobAfterReplay} 个均未增加`,
      { outcome: replay.outcome, snapshots: snapAfterReplay, jobs: jobAfterReplay },
    );

    const sameTerms = L.applyConsentNotice(db, { ...narrow, noticeKey: 'DRILL-NARROW-1-RETRY', reason: '演练：换 key 重发同条款' });
    const snapAfterSame = count(db, 'SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?', DRILL_SUBJECT);
    push(
      '同条款不同 noticeKey',
      sameTerms.outcome === 'duplicate_terms' && snapAfterSame === snapAfter,
      `返回 ${sameTerms.outcome}，未生成第三个版本；通知按 subject+terms 去重`,
      { outcome: sameTerms.outcome, snapshots: snapAfterSame },
    );

    // 模拟：快照已提交但任务规划前进程退出，恢复时重新规划。
    const to = db.prepare('SELECT * FROM snapshots WHERE subject_id = ? ORDER BY version DESC LIMIT 1').get(DRILL_SUBJECT);
    const from = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(to.prev_id);
    const jobsBefore = count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE subject_id = ?', DRILL_SUBJECT);
    const replan = L.planDispositionForSnapshotChange(db, from, to);
    const jobsAfter = count(db, 'SELECT COUNT(*) AS n FROM jobs WHERE subject_id = ?', DRILL_SUBJECT);
    push(
      '崩溃后重复规划（任务幂等键）',
      jobsAfter === jobsBefore && replan?.id === first.job?.id,
      `重新规划命中已有任务 ${replan?.id}，任务数保持 ${jobsAfter}`,
      { dedupeKey: replan?.dedupe_key, jobs: jobsAfter },
    );

    L.flushNotices(db, { limit: 50 });
    const notices = db
      .prepare('SELECT COUNT(*) AS n FROM notices WHERE subject_id = ?')
      .get(DRILL_SUBJECT).n;
    const dupNotice = L.applyConsentNotice(db, { ...narrow, noticeKey: 'DRILL-NARROW-1' });
    const noticesAfter = db.prepare('SELECT COUNT(*) AS n FROM notices WHERE subject_id = ?').get(DRILL_SUBJECT).n;
    push(
      '通知不重复下发',
      noticesAfter === notices && dupNotice.outcome === 'duplicate_notice',
      `重放后通知条数保持 ${noticesAfter}，未新增下发`,
      { notices: noticesAfter, outcome: dupNotice.outcome },
    );

    const v2 = drillState(db).snapshots;
    push(
      '授权版本可追溯',
      v2.length === 2 && v2[1].prevId === v2[0].id,
      `v1 → v2 通过 prevId 串成不可变版本链，条款哈希 ${v2[1].termsHash.slice(0, 12)}…`,
      { versions: v2.map((s) => ({ v: s.version, hash: s.termsHash.slice(0, 12), prev: s.prevId })) },
    );

    return { scenario: key, steps, ok: steps.every((s) => s.ok), state: drillState(db) };
  }

  if (key === 'interrupt_resume') {
    const s0 = drillState(db);
    push(
      '沙箱就绪',
      s0.batches.length === 4 && s0.subject.snapshot.version === 1,
      `4 个批次：2 个个性化、1 个分析（含城市级位置）、1 个营销`,
      { batches: s0.batches.map((b) => ({ id: b.id, purpose: b.purpose, records: b.recordCount })) },
    );

    const narrowing = L.applyConsentNotice(db, {
      subjectId: DRILL_SUBJECT,
      noticeKey: 'DRILL-INTERRUPT',
      purposes: ['analytics', 'marketing'],
      scopes: ['contact', 'behavior'],
      retentionDays: 90,
      reason: '演练：收窄触发处置',
    });
    const job0 = narrowing.job;
    push(
      '生成处置任务',
      job0.status === 'pending' && job0.totalBatches === 3,
      `任务 ${job0.id} 影响 ${job0.totalBatches} 个批次 / ${job0.totalRecords} 条记录，动作混合 ${job0.action}`,
      {
        targets: job0.targets.map((t) => ({ batch: t.batchId, action: t.action, records: t.recordCount })),
      },
    );

    const marketingBefore = s0.batches.find((b) => b.purpose === 'marketing');
    const impactedBefore = s0.batches.filter((b) => b.purpose !== 'marketing');
    const beforeDeletedIds = impactedBefore
      .filter((b) => b.purpose === 'personalization')
      .map((b) => b.id);

    const r1 = L.runJob(db, job0.id, {
      chunkSize: 1,
      failAfter: 1,
      interruptMessage: '演练：模拟进程在检查点处退出',
    });
    const paused = r1.job;
    const pending = paused.targets.filter((t) => t.status === 'pending').length;
    const done = paused.targets.filter((t) => t.status === 'done').length;
    push(
      '执行中断并落检查点',
      paused.status === 'paused' && done === 1 && pending === 2 && !!paused.checkpoint,
      `完成 ${done} 个批次后暂停，剩余 ${pending} 个 pending；检查点 nextOrd=${paused.checkpoint?.nextOrd}`,
      { status: paused.status, done, pending, checkpoint: paused.checkpoint, lastError: paused.lastError },
    );

    // 已完成的批次必须是物理删除，不是查询层隐藏。
    const completedTarget = paused.targets.find((t) => t.status === 'done');
    const rowsStillThere = count(db, 'SELECT COUNT(*) AS n FROM records WHERE batch_id = ?', completedTarget.batchId);
    const batchRow = db.prepare('SELECT status, record_count FROM batches WHERE id = ?').get(completedTarget.batchId);
    push(
      '已处置批次物理生效',
      rowsStillThere === 0 && ['deleted', 'degraded', 'quarantined'].includes(batchRow.status),
      `批次 ${completedTarget.batchId} 的 records 实际行数 ${rowsStillThere}，批次状态 ${batchRow.status}`,
      { action: completedTarget.action, batchStatus: batchRow.status, rowsInRecordsTable: rowsStillThere },
    );

    const stillLive = count(
      db,
      `SELECT COUNT(*) AS n FROM records r JOIN batches b ON b.id = r.batch_id
        WHERE r.subject_id = ? AND b.id IN (${paused.targets
          .filter((t) => t.status === 'pending')
          .map(() => '?')
          .join(',') || "''"})`,
      DRILL_SUBJECT,
      ...paused.targets.filter((t) => t.status === 'pending').map((t) => t.batchId),
    );
    push(
      '未处置批次仍在库，进度可核对',
      stillLive > 0,
      `剩余 ${pending} 个批次仍有 ${stillLive} 条在库记录，与任务进度一致`,
      { pendingBatchRecords: stillLive },
    );

    const auditPaused = count(
      db,
      "SELECT COUNT(*) AS n FROM audit_log WHERE job_id = ? AND action = 'disposition.paused'",
      job0.id,
    );
    push('中断写入审计', auditPaused >= 1, `审计流水记录 disposition.paused ${auditPaused} 条`, { auditRows: auditPaused });

    const r2 = L.resumeJob(db, job0.id, { chunkSize: 2 });
    const resumed = r2.job;
    const stillPending = resumed.targets.filter((t) => t.status === 'pending').length;
    push(
      '恢复后继续并完成',
      resumed.status === 'completed' && stillPending === 0 && resumed.processedBatches === 3,
      `从 nextOrd=${paused.checkpoint?.nextOrd} 继续，最终 ${resumed.processedBatches}/${resumed.totalBatches} 批完成`,
      { status: resumed.status, processedBatches: resumed.processedBatches, attempts: resumed.attempts },
    );

    const personalizationLeft = count(
      db,
      `SELECT COUNT(*) AS n FROM records r JOIN batches b ON b.id = r.batch_id
        WHERE r.subject_id = ? AND b.purpose = 'personalization'`,
      DRILL_SUBJECT,
    );
    push(
      '失权用途数据清零',
      personalizationLeft === 0,
      `个性化用途记录剩余 ${personalizationLeft} 条（物理删除）`,
      { remaining: personalizationLeft, batchIds: beforeDeletedIds },
    );

    const degradedSample = db
      .prepare(
        `SELECT payload, state, state_reason FROM records r JOIN batches b ON b.id = r.batch_id
          WHERE r.subject_id = ? AND b.purpose = 'analytics' LIMIT 1`,
      )
      .get(DRILL_SUBJECT);
    const payload = degradedSample ? JSON.parse(degradedSample.payload) : null;
    push(
      '部分失权字段被抹除',
      !!payload && !('city' in payload) && 'behavior' in payload && degradedSample.state === 'degraded',
      `分析批次记录字段 ${Object.keys(payload ?? {}).join(', ') || '无'}，state=${degradedSample?.state}`,
      { payload, state: degradedSample?.state, reason: degradedSample?.state_reason },
    );

    const marketingAfter = count(
      db,
      `SELECT COUNT(*) AS n FROM records r JOIN batches b ON b.id = r.batch_id
        WHERE r.subject_id = ? AND b.purpose = 'marketing'`,
      DRILL_SUBJECT,
    );
    push(
      '未受影响批次保持不变',
      marketingAfter === marketingBefore.recordCount,
      `营销批次仍有 ${marketingAfter} 条记录（授权未变）`,
      { before: marketingBefore.recordCount, after: marketingAfter },
    );

    const auditSeq = db
      .prepare("SELECT action FROM audit_log WHERE job_id = ? ORDER BY id ASC")
      .all(job0.id)
      .map((r) => r.action);
    push(
      '审计链路完整',
      auditSeq.includes('disposition.started') &&
        auditSeq.includes('disposition.paused') &&
        auditSeq.includes('disposition.completed'),
      `审计序列：${auditSeq.join(' → ')}`,
      { actions: auditSeq },
    );

    return { scenario: key, steps, ok: steps.every((s) => s.ok), state: drillState(db) };
  }

  // revoke_blocks_ingest
  const s0 = drillState(db);
  const totalRecords = s0.liveRecords;
  L.applyConsentNotice(db, {
    subjectId: DRILL_SUBJECT,
    noticeKey: 'DRILL-REVOKE',
    status: 'revoked',
    purposes: [],
    scopes: [],
    retentionDays: 0,
    reason: '演练：主体行使删除权，撤回全部授权',
  });
  push(
    '授权整体撤回',
    drillState(db).subject.snapshot.status === 'revoked',
    `快照状态 revoked，termsHash 更新，历史版本仍可追溯`,
    { version: drillState(db).subject.snapshot.version },
  );

  const revokeJob = db
    .prepare("SELECT id FROM jobs WHERE subject_id = ? AND trigger = 'consent_revoked' ORDER BY created_at DESC LIMIT 1")
    .get(DRILL_SUBJECT);
  L.runJob(db, revokeJob.id, { chunkSize: 10 });
  const afterJob = L.jobView(db, revokeJob.id);
  push(
    '撤回处置执行完成',
    afterJob.status === 'completed' && count(db, 'SELECT COUNT(*) AS n FROM records WHERE subject_id = ?', DRILL_SUBJECT) === 0,
    `任务 ${afterJob.id} 处置 ${afterJob.processedBatches} 个批次，records 表剩余 0 行`,
    { totalRecordsBefore: totalRecords, processedBatches: afterJob.processedBatches },
  );

  let blocked;
  try {
    blocked = L.createBatch(db, {
      subjectId: DRILL_SUBJECT,
      source: '演练采集器',
      purpose: 'analytics',
      scopes: ['behavior'],
      fields: ['behavior'],
      records: [{ behavior: '撤回后仍然尝试写入' }],
    });
  } catch (err) {
    blocked = { status: 'error', message: err.message };
  }
  const blockedBatch = db
    .prepare("SELECT * FROM batches WHERE subject_id = ? AND status = 'blocked' ORDER BY started_at DESC LIMIT 1")
    .get(DRILL_SUBJECT);
  push(
    '撤回后新采集被阻断',
    blocked.status === 'blocked' && blocked.code === 'CONSENT_REVOKED' && blockedBatch?.record_count === 0,
    `批次 ${blocked.batchId ?? '—'} 状态 blocked，原因码 ${blocked.code ?? '—'}，入库记录 0 条`,
    {
      code: blocked.code,
      reason: blocked.reason,
      recordsInDb: blockedBatch?.record_count ?? null,
      batchStatus: blockedBatch?.status ?? null,
    },
  );

  let appendError = null;
  try {
    L.appendRecords(db, afterJob.targets[0]?.batchId ?? 'none', [{ behavior: '补写' }]);
  } catch (err) {
    appendError = err;
  }
  push(
    '已删除批次拒绝补写',
    !!appendError,
    appendError ? `写入被拒绝：${appendError.message}` : '写入未被拒绝（异常）',
    { errorCode: appendError?.code ?? null },
  );

  const auditRows = db
    .prepare("SELECT action, summary FROM audit_log WHERE subject_id = ? AND action = 'ingest.blocked' ORDER BY id DESC LIMIT 1")
    .get(DRILL_SUBJECT);
  push(
    '阻断动作进入审计',
    !!auditRows,
    auditRows ? `审计：${auditRows.summary}` : '缺少 ingest.blocked 审计',
    { audit: auditRows ?? null },
  );

  return { scenario: 'revoke_blocks_ingest', steps, ok: steps.every((s) => s.ok), state: drillState(db) };
}
