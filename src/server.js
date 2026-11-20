import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { openDb } from './db.js';
import * as L from './ledger.js';
import { PURPOSES, SCOPES, FIELD_SCOPE, JOB_TRIGGERS, ACTOR, purposeLabel } from './meta.js';
import { parseJson } from './util.js';
import { SCENARIOS, runScenario, resetDrill, drillState } from './drill.js';

const __dirname = new URL('.', import.meta.url).pathname;
const PUBLIC_DIR = resolve(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR ?? resolve(__dirname, '..', 'data');
const DB_FILE = process.env.DB_FILE ?? join(DATA_DIR, 'ledger.db');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createApp({ dbFile = DB_FILE, db: injected } = {}) {
  const db = injected ?? openDb(dbFile);

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      `^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      })}$`,
    );
    routes.push({ method, re, keys, handler });
  };

  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  };

  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2_000_000) throw new L.LedgerError('E_BODY_TOO_LARGE', '请求体过大', 413);
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new L.LedgerError('E_BAD_JSON', '请求体不是合法 JSON');
    }
  };

  /* --------------------------- 元数据 --------------------------- */

  route('GET', '/api/meta', () => ({
    purposes: Object.entries(PURPOSES).map(([key, v]) => ({ key, ...v })),
    scopes: Object.entries(SCOPES).map(([key, v]) => ({ key, ...v })),
    fieldScope: FIELD_SCOPE,
    jobTriggers: JOB_TRIGGERS,
    actor: ACTOR,
    maxRetentionDays: 730,
  }));

  /* --------------------------- 主体 --------------------------- */

  const subjectView = (s) => {
    const snap = L.effectiveSnapshot(db, s.id);
    const batchAgg = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'sealed' THEN 1 ELSE 0 END) AS sealed,
           SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
           SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS deleted,
           SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) AS quarantined,
           SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
           SUM(CASE WHEN status = 'collecting' THEN 1 ELSE 0 END) AS collecting
         FROM batches WHERE subject_id = ?`,
      )
      .get(s.id);
    const live = db
      .prepare(`SELECT COUNT(*) AS n FROM records WHERE subject_id = ? AND state IN ('live','degraded')`)
      .get(s.id).n;
    const openJobs = db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE subject_id = ? AND status IN ('pending','running','paused','failed')`,
      )
      .get(s.id).n;
    return {
      id: s.id,
      name: s.name,
      channel: s.channel,
      contactHint: s.contact_hint,
      legalHold: !!s.legal_hold,
      holdReason: s.hold_reason,
      snapshot: L.snapshotView(snap),
      batchCounts: {
        total: batchAgg.total ?? 0,
        sealed: batchAgg.sealed ?? 0,
        blocked: batchAgg.blocked ?? 0,
        deleted: batchAgg.deleted ?? 0,
        quarantined: batchAgg.quarantined ?? 0,
        degraded: batchAgg.degraded ?? 0,
        collecting: batchAgg.collecting ?? 0,
      },
      liveRecords: live,
      openJobs,
    };
  };

  route('GET', '/api/subjects', () =>
    db.prepare('SELECT * FROM subjects ORDER BY created_at ASC').all().map(subjectView),
  );

  route('GET', '/api/subjects/:id', (m) => {
    const s = db.prepare('SELECT * FROM subjects WHERE id = ?').get(m.id);
    if (!s) throw new L.LedgerError('E_SUBJECT_NOT_FOUND', '主体不存在', 404);
    return {
      ...subjectView(s),
      snapshots: db
        .prepare('SELECT * FROM snapshots WHERE subject_id = ? ORDER BY version DESC')
        .all(s.id)
        .map(L.snapshotView),
      batches: db
        .prepare('SELECT * FROM batches WHERE subject_id = ? ORDER BY started_at DESC')
        .all(s.id)
        .map((b) => batchView(b)),
      jobs: db
        .prepare('SELECT id FROM jobs WHERE subject_id = ? ORDER BY created_at DESC')
        .all(s.id)
        .map((j) => L.jobView(db, j.id)),
    };
  });

  /* --------------------------- 批次 --------------------------- */

  const batchView = (b) => {
    const snap = L.getSnapshot(db, b.snapshot_id);
    return {
      id: b.id,
      subjectId: b.subject_id,
      subjectName: db.prepare('SELECT name FROM subjects WHERE id = ?').get(b.subject_id)?.name,
      source: b.source,
      purpose: b.purpose,
      purposeLabel: purposeLabel(b.purpose),
      scopes: parseJson(b.scopes, []),
      fields: parseJson(b.fields, []),
      retentionDays: b.retention_days,
      requestedRetention: b.requested_retention,
      snapshotId: b.snapshot_id,
      snapshotVersion: b.snapshot_version,
      snapshotStatus: snap?.status ?? null,
      termsHash: b.terms_hash,
      status: b.status,
      blockCode: b.block_code,
      blockReason: b.block_reason,
      compliance: b.compliance,
      recordCount: b.record_count,
      startedAt: b.started_at,
      sealedAt: b.sealed_at,
      flaggedAt: b.flagged_at,
      flaggedBySnapshot: b.flagged_by_snapshot,
      disposedAction: b.disposed_action,
      disposedAt: b.disposed_at,
      disposedByJob: b.disposed_by_job,
      legalHold: !!b.legal_hold,
      holdReason: b.hold_reason,
    };
  };

  route('GET', '/api/batches', (m) => {
    const subjectId = m.query.get('subjectId');
    const rows = subjectId
      ? db.prepare('SELECT * FROM batches WHERE subject_id = ? ORDER BY started_at DESC').all(subjectId)
      : db.prepare('SELECT * FROM batches ORDER BY started_at DESC').all();
    return rows.map(batchView);
  });

  route('GET', '/api/batches/:id', (m) => {
    const b = db.prepare('SELECT * FROM batches WHERE id = ?').get(m.id);
    if (!b) throw new L.LedgerError('E_BATCH_NOT_FOUND', '批次不存在', 404);
    const records = db
      .prepare('SELECT id, payload, captured_at, state, state_reason FROM records WHERE batch_id = ? ORDER BY id ASC LIMIT 20')
      .all(b.id)
      .map((r) => ({
        id: r.id,
        payload: parseJson(r.payload, {}),
        capturedAt: r.captured_at,
        state: r.state,
        stateReason: r.state_reason,
      }));
    const vaults = db
      .prepare('SELECT * FROM vault_batches WHERE batch_id = ? ORDER BY created_at DESC')
      .all(b.id)
      .map((v) => ({
        id: v.id,
        reason: v.reason,
        legalHold: !!v.legal_hold,
        entryCount: v.entry_count,
        state: v.state,
        createdAt: v.created_at,
      }));
    const auditRows = db
      .prepare('SELECT * FROM audit_log WHERE batch_id = ? ORDER BY id DESC LIMIT 50')
      .all(b.id)
      .map(auditView);
    return { batch: batchView(b), records, vaults, audit: auditRows };
  });

  route('POST', '/api/batches', async (m) => {
    const body = await readBody(m.req);
    const result = L.createBatch(db, body);
    return { ...result, batch: batchView(db.prepare('SELECT * FROM batches WHERE id = ?').get(result.batchId)) };
  });

  route('POST', '/api/batches/:id/records', async (m) => {
    const body = await readBody(m.req);
    const records = Array.isArray(body) ? body : body.records ?? [];
    return L.appendRecords(db, m.id, records);
  });

  route('POST', '/api/batches/:id/seal', (m) => {
    const res = L.sealBatch(db, m.id);
    return { ...res, batch: batchView(db.prepare('SELECT * FROM batches WHERE id = ?').get(m.id)) };
  });

  /* --------------------------- 授权通知 --------------------------- */

  route('POST', '/api/consent/notices', async (m) => {
    const body = await readBody(m.req);
    return L.applyConsentNotice(db, body);
  });

  route('GET', '/api/consent/notices', () =>
    db
      .prepare('SELECT * FROM consent_notices ORDER BY received_at DESC LIMIT 50')
      .all()
      .map((n) => ({
        id: n.id,
        subjectId: n.subject_id,
        noticeKey: n.notice_key,
        outcome: n.outcome,
        snapshotId: n.snapshot_id,
        receivedAt: n.received_at,
        payload: parseJson(n.payload, {}),
      })),
  );

  route('GET', '/api/notices', () =>
    db
      .prepare('SELECT * FROM notices ORDER BY created_at DESC LIMIT 100')
      .all()
      .map((n) => ({
        id: n.id,
        subjectId: n.subject_id,
        jobId: n.job_id,
        template: n.template,
        status: n.status,
        dedupeKey: n.dedupe_key,
        attempts: n.attempts,
        createdAt: n.created_at,
        sentAt: n.sent_at,
      })),
  );

  route('POST', '/api/notices/flush', async (m) => {
    const body = await readBody(m.req);
    return L.flushNotices(db, body);
  });

  /* --------------------------- 处置任务 --------------------------- */

  route('GET', '/api/jobs', () => {
    const rows = db.prepare('SELECT id FROM jobs ORDER BY created_at DESC LIMIT 100').all();
    return rows.map((r) => L.jobView(db, r.id));
  });

  route('GET', '/api/jobs/:id', (m) => {
    const job = L.jobView(db, m.id);
    if (!job) throw new L.LedgerError('E_JOB_NOT_FOUND', '任务不存在', 404);
    return {
      ...job,
      audit: db.prepare('SELECT * FROM audit_log WHERE job_id = ? ORDER BY id ASC').all(m.id).map(auditView),
    };
  });

  route('POST', '/api/jobs/:id/run', async (m) => {
    const body = await readBody(m.req);
    return L.runJob(db, m.id, { ...body, resume: body.resume ?? true });
  });

  route('POST', '/api/jobs/:id/resume', async (m) => {
    const body = await readBody(m.req);
    return L.resumeJob(db, m.id, body);
  });

  route('POST', '/api/jobs/:id/pause', (m) => ({ job: L.pauseJob(db, m.id, '人工暂停') }));

  route('POST', '/api/jobs/:id/retry', (m) => ({ job: L.retryJob(db, m.id) }));

  /* --------------------------- 隔离区 / 保全 --------------------------- */

  route('GET', '/api/vault', () =>
    db
      .prepare('SELECT * FROM vault_batches ORDER BY created_at DESC')
      .all()
      .map((v) => ({
        id: v.id,
        subjectId: v.subject_id,
        batchId: v.batch_id,
        jobId: v.job_id,
        reason: v.reason,
        legalHold: !!v.legal_hold,
        entryCount: v.entry_count,
        state: v.state,
        createdAt: v.created_at,
        updatedAt: v.updated_at,
      })),
  );

  route('POST', '/api/vault/:id/release', async (m) => {
    const body = await readBody(m.req);
    return L.releaseVault(db, m.id, {
      dispose: body.dispose === 'purge' ? 'purge' : 'restore',
      reason: body.reason ?? '',
    });
  });

  /* --------------------------- 审计 / 留存 --------------------------- */

  const auditView = (a) => ({
    id: a.id,
    at: a.at,
    actor: a.actor,
    actorRole: a.actor_role,
    action: a.action,
    subjectId: a.subject_id,
    jobId: a.job_id,
    batchId: a.batch_id,
    snapshotId: a.snapshot_id,
    summary: a.summary,
    detail: parseJson(a.detail, {}),
  });

  route('GET', '/api/audit', (m) => {
    const filters = [];
    const args = [];
    for (const [k, col] of [
      ['subjectId', 'subject_id'],
      ['jobId', 'job_id'],
      ['batchId', 'batch_id'],
      ['action', 'action'],
    ]) {
      if (m.query.get(k)) {
        filters.push(`${col} = ?`);
        args.push(m.query.get(k));
      }
    }
    const limit = Math.min(Number(m.query.get('limit') ?? 200), 1000);
    const sql = `SELECT * FROM audit_log ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`;
    return db.prepare(sql).all(...args).map(auditView);
  });

  route('POST', '/api/retention/sweep', async (m) => {
    const body = await readBody(m.req);
    return L.sweepRetention(db, body);
  });

  route('GET', '/api/retention/preview', () => L.sweepRetention(db, { dryRun: true }));

  route('GET', '/api/records', (m) =>
    L.queryRecords(db, {
      subjectId: m.query.get('subjectId') ?? undefined,
      purpose: m.query.get('purpose') ?? undefined,
      scope: m.query.get('scope') ?? undefined,
    }),
  );

  /* --------------------------- 概览 --------------------------- */

  route('GET', '/api/overview', () => {
    const subjects = db.prepare('SELECT * FROM subjects ORDER BY created_at ASC').all().map(subjectView);
    const jobs = db.prepare('SELECT id FROM jobs ORDER BY created_at DESC').all().map((j) => L.jobView(db, j.id));
    const statusCounts = {};
    for (const j of jobs) statusCounts[j.status] = (statusCounts[j.status] ?? 0) + 1;
    const totals = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM records) AS liveRecords,
           (SELECT COUNT(*) FROM batches) AS batches,
           (SELECT COUNT(*) FROM snapshots) AS snapshots,
           (SELECT COUNT(*) FROM audit_log) AS auditEntries,
           (SELECT COUNT(*) FROM vault_entries WHERE state = 'held') AS heldEntries,
           (SELECT COALESCE(SUM(record_count),0) FROM batches WHERE status = 'blocked') AS blockedRecords`,
      )
      .get();
    const recentAudit = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 8').all().map(auditView);
    return {
      subjects,
      jobs,
      jobStatusCounts: statusCounts,
      totals: { ...totals },
      recentAudit,
      actionMix: jobs.reduce((acc, j) => {
        acc[j.action] = (acc[j.action] ?? 0) + 1;
        return acc;
      }, {}),
    };
  });

  /* --------------------------- 演练验证 --------------------------- */

  route('GET', '/api/drill', () => ({
    scenarios: SCENARIOS,
    state: drillState(db),
  }));

  route('POST', '/api/drill/reset', () => ({ state: resetDrill(db) }));

  route('POST', '/api/drill/:key/run', (m) => runScenario(db, m.key));

  /* --------------------------- 静态资源 --------------------------- */

  const serveStatic = async (req, res, pathname) => {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    const full = normalize(join(PUBLIC_DIR, rel));
    if (!full.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const data = await readFile(full);
      res.writeHead(200, {
        'content-type': MIME[extname(full)] ?? 'application/octet-stream',
        'cache-control': extname(full) === '.html' ? 'no-cache' : 'public, max-age=60',
      });
      res.end(data);
    } catch {
      // SPA 回退
      try {
        const html = await readFile(join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
        res.end(html);
      } catch {
        res.writeHead(404).end('not found');
      }
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;
    if (!pathname.startsWith('/api/')) {
      await serveStatic(req, res, pathname);
      return;
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.re.exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
      try {
        const result = await r.handler({ req, res, query: url.searchParams, ...params });
        if (result !== undefined && !res.writableEnded) json(res, 200, result);
      } catch (err) {
        const status = err instanceof L.LedgerError ? err.status : 500;
        if (status === 500) console.error(err);
        json(res, status, {
          error: {
            code: err.code ?? 'E_INTERNAL',
            message: err.message,
            extra: err.extra ?? {},
          },
        });
      }
      return;
    }
    json(res, 404, { error: { code: 'E_NOT_FOUND', message: `未知接口 ${req.method} ${pathname}` } });
  });

  function query(sql, args) {
    return { rows: db.prepare(sql).all(...args) };
  }
  void query;

  return { server, db, routes };
}

export function startServer({ port = process.env.PORT ?? 4173, dbFile, db } = {}) {
  const app = createApp({ dbFile, db });
  return new Promise((resolvePromise) => {
    app.server.listen(port, () => resolvePromise(app));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 4173);
  app.server.listen(port, () => {
    console.log(`授权快照数据接入层已启动：http://localhost:${port}`);
    console.log(`数据库：${process.env.DB_FILE ?? join(DATA_DIR, 'ledger.db')}`);
  });
}

void SCOPES;
void FIELD_SCOPE;
