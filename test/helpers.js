import { openDb } from '../src/db.js';
import { nowIso, addDays, parseJson } from '../src/util.js';
import * as L from '../src/ledger.js';

/** 每个测试用独立的内存库，互不影响。 */
export function freshDb() {
  return openDb(':memory:');
}

export function addSubject(db, id = 'sub_test', extra = {}) {
  db.prepare(
    'INSERT INTO subjects (id, name, channel, contact_hint, legal_hold, hold_reason, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(
    id,
    extra.name ?? '测试主体',
    extra.channel ?? 'App',
    extra.contactHint ?? '138****0000',
    extra.legalHold ? 1 : 0,
    extra.holdReason ?? null,
    extra.createdAt ?? addDays(nowIso(), -200),
  );
  return id;
}

export function consent(db, subjectId, overrides = {}) {
  const n = (consent.seq = (consent.seq ?? 0) + 1);
  return L.applyConsentNotice(db, {
    subjectId,
    noticeKey: overrides.noticeKey ?? `NOTICE-${n}`,
    purposes: overrides.purposes ?? ['analytics', 'personalization', 'marketing'],
    scopes: overrides.scopes ?? ['contact', 'behavior', 'location_coarse'],
    retentionDays: overrides.retentionDays ?? 180,
    reason: overrides.reason ?? '测试授权',
    effectiveAt: overrides.effectiveAt,
  });
}

/** 建一个已封存、带 records 的批次；可选回拨时间。 */
export function seedBatch(db, subjectId, opts) {
  const res = L.createBatch(db, {
    subjectId,
    source: opts.source ?? '测试采集器',
    purpose: opts.purpose,
    scopes: opts.scopes,
    fields: opts.fields,
    retentionDays: opts.retentionDays,
    records: opts.records ?? Array.from({ length: opts.n ?? 5 }, () => opts.record ?? sampleFor(opts.fields)),
  });
  if (res.status !== 'collecting') throw new Error(`seedBatch 被阻断：${res.code} ${res.reason}`);
  L.sealBatch(db, res.batchId);
  if (opts.capturedDaysAgo != null) {
    const at = addDays(nowIso(), -opts.capturedDaysAgo);
    db.prepare('UPDATE batches SET started_at = ?, sealed_at = ? WHERE id = ?').run(at, at, res.batchId);
    db.prepare('UPDATE records SET captured_at = ? WHERE batch_id = ?').run(at, res.batchId);
  }
  return res.batchId;
}

function sampleFor(fields = []) {
  const sample = {
    contact: '13800001111',
    device_id: 'dv-test',
    lat: 30.27,
    lng: 120.15,
    city: '杭州市',
    behavior: '浏览商品',
    voice: 'call_001.wav',
  };
  const out = {};
  for (const f of fields) out[f] = sample[f] ?? 'x';
  return out;
}

export { L, parseJson, addDays, nowIso };

export function count(db, sql, ...args) {
  return db.prepare(sql).get(...args).n;
}

export function auditActions(db, filter = {}) {
  const where = [];
  const args = [];
  for (const [k, v] of Object.entries(filter)) {
    where.push(`${k} = ?`);
    args.push(v);
  }
  return db
    .prepare(`SELECT action FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ASC`)
    .all(...args)
    .map((r) => r.action);
}

/** 直接用 SQL 读 records 行数——验证物理变化而非查询层过滤。 */
export function rowsInTable(db, table, where = '1=1', ...args) {
  return count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...args);
}
