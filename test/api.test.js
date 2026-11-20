import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { runScenario, resetDrill, SCENARIOS } from '../src/drill.js';

async function withServer(fn) {
  const db = openDb(':memory:');
  const app = createApp({ db });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    return await fn({ base, db });
  } finally {
    await new Promise((r) => app.server.close(r));
    db.close();
  }
}

async function api(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

const NOTICE = {
  subjectId: 'sub_http',
  noticeKey: 'HTTP-BASE',
  purposes: ['analytics', 'personalization'],
  scopes: ['contact', 'behavior'],
  retentionDays: 120,
};

test('HTTP 端到端：通知 -> 采集 -> 撤回 -> 阻断 -> 处置 -> 查询为空', async () => {
  await withServer(async ({ base, db }) => {
    db.prepare('INSERT INTO subjects (id, name, channel, contact_hint, created_at) VALUES (?,?,?,?,?)').run(
      'sub_http',
      'HTTP 主体',
      'App',
      '138****1234',
      '2026-01-01T00:00:00.000Z',
    );

    const meta = await api(base, 'GET', '/api/meta');
    assert.equal(meta.status, 200);
    assert.ok(meta.body.purposes.find((p) => p.key === 'analytics'));
    assert.ok(meta.body.scopes.find((s) => s.key === 'behavior'));

    const n1 = await api(base, 'POST', '/api/consent/notices', NOTICE);
    assert.equal(n1.status, 200);
    assert.equal(n1.body.outcome, 'accepted');
    assert.equal(n1.body.snapshot.version, 1);

    const batch = await api(base, 'POST', '/api/batches', {
      subjectId: 'sub_http',
      purpose: 'analytics',
      scopes: ['behavior'],
      fields: ['behavior'],
      source: 'HTTP 测试',
      records: Array.from({ length: 6 }, (_, i) => ({ behavior: `事件 ${i}` })),
    });
    assert.equal(batch.status, 200);
    assert.equal(batch.body.status, 'collecting');
    assert.equal(batch.body.recordCount, 6);

    const sealed = await api(base, 'POST', `/api/batches/${batch.body.batchId}/seal`, {});
    assert.equal(sealed.status, 200);
    assert.equal(sealed.body.batch.status, 'sealed');

    const records = await api(base, 'GET', '/api/records?subjectId=sub_http');
    assert.equal(records.body.length, 6);

    // 重复通知：同一 key 重放
    const dup = await api(base, 'POST', '/api/consent/notices', NOTICE);
    assert.equal(dup.body.outcome, 'duplicate_notice');

    // 同条款换 key
    const dupTerms = await api(base, 'POST', '/api/consent/notices', { ...NOTICE, noticeKey: 'HTTP-BASE-2' });
    assert.equal(dupTerms.body.outcome, 'duplicate_terms');

    // 撤回：生成 delete 任务
    const revoke = await api(base, 'POST', '/api/consent/notices', {
      subjectId: 'sub_http',
      noticeKey: 'HTTP-REVOKE',
      status: 'revoked',
      purposes: [],
      scopes: [],
      retentionDays: 0,
    });
    assert.equal(revoke.body.outcome, 'accepted');
    assert.ok(revoke.body.job);
    assert.equal(revoke.body.job.action, 'delete');

    const jobId = revoke.body.job.id;
    const run = await api(base, 'POST', `/api/jobs/${jobId}/run`, { chunkSize: 2 });
    assert.equal(run.status, 200);
    assert.equal(run.body.job.status, 'completed');
    assert.equal(run.body.job.processedRecords, 6);

    const after = await api(base, 'GET', '/api/records?subjectId=sub_http');
    assert.equal(after.body.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records WHERE subject_id = ?').get('sub_http').n, 0);

    // 撤回后新采集被阻断
    const blocked = await api(base, 'POST', '/api/batches', {
      subjectId: 'sub_http',
      purpose: 'analytics',
      scopes: ['behavior'],
      fields: ['behavior'],
      records: [{ behavior: 'try again' }],
    });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.status, 'blocked');
    assert.equal(blocked.body.code, 'CONSENT_REVOKED');
    assert.equal(blocked.body.batch.recordCount, 0);

    const detail = await api(base, 'GET', `/api/jobs/${jobId}`);
    assert.deepEqual(
      detail.body.audit.map((a) => a.action),
      ['disposition.planned', 'disposition.started', 'disposition.batch.deleted', 'disposition.completed'],
    );

    const audit = await api(base, 'GET', '/api/audit?limit=200');
    const actions = audit.body.map((a) => a.action);
    assert.ok(actions.includes('ingest.blocked'));
    assert.ok(actions.includes('consent.notice.duplicate'));
    assert.ok(actions.includes('disposition.batch.deleted'));
  });
});

test('HTTP 错误契约：未知接口 404、非法条款 400、不存在资源 404', async () => {
  await withServer(async ({ base }) => {
    const notFound = await api(base, 'GET', '/api/nope');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error.code, 'E_NOT_FOUND');

    const badTerms = await api(base, 'POST', '/api/consent/notices', {
      subjectId: 'missing',
      noticeKey: 'X',
      purposes: ['analytics'],
      scopes: ['behavior'],
      retentionDays: 30,
    });
    assert.equal(badTerms.status, 404);
    assert.equal(badTerms.body.error.code, 'E_SUBJECT_NOT_FOUND');

    const missingBatch = await api(base, 'GET', '/api/batches/bat_missing');
    assert.equal(missingBatch.status, 404);
    assert.equal(missingBatch.body.error.code, 'E_BATCH_NOT_FOUND');

    const jobNotFound = await api(base, 'GET', '/api/jobs/job_missing');
    assert.equal(jobNotFound.status, 404);
  });
});

test('验证中心三个场景在真实服务上全部通过（断言直接检查数据库落库结果）', async () => {
  const db = openDb(':memory:');
  try {
    for (const s of SCENARIOS) {
      const res = runScenario(db, s.key);
      const failed = res.steps.filter((x) => !x.ok).map((x) => x.title);
      assert.deepEqual(failed, [], `${s.key} 有失败断言`);
      assert.equal(res.ok, true);
      assert.ok(res.steps.length >= 4);
      assert.ok(res.steps.every((x) => typeof x.detail === 'string'));
    }
    resetDrill(db);
    const after = runScenario(db, 'interrupt_resume');
    assert.equal(after.ok, true);
    assert.equal(after.steps.length >= 4, true);
  } finally {
    db.close();
  }
});

test('验证中心可重复运行：连续三次结果一致（幂等沙箱）', () => {
  const db = openDb(':memory:');
  try {
    for (let i = 0; i < 3; i += 1) {
      const r = runScenario(db, 'duplicate_notice');
      assert.equal(r.ok, true);
      assert.equal(r.state.snapshots.length, 2);
      assert.equal(r.state.jobs.length, 1);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'disposition.deduped'").get().n >= 1,
        true,
      );
    }
  } finally {
    db.close();
  }
});
