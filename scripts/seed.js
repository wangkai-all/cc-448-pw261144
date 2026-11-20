import { rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDb } from '../src/db.js';
import * as L from '../src/ledger.js';
import { nowIso, addDays } from '../src/util.js';

const DB_FILE = process.env.DB_FILE ?? resolve(new URL('.', import.meta.url).pathname, '..', 'data', 'ledger.db');

const daysAgo = (n) => addDays(nowIso(), -n);

function insertSubject(db, id, name, channel, contactHint, createdAt) {
  db.prepare(
    'INSERT INTO subjects (id, name, channel, contact_hint, created_at) VALUES (?,?,?,?,?)',
  ).run(id, name, channel, contactHint, createdAt);
}

function backdateBatch(db, batchId, { startedDaysAgo, sealedDaysAgo, capturedDaysAgo }) {
  db.prepare('UPDATE batches SET started_at = ?, sealed_at = ? WHERE id = ?').run(
    daysAgo(startedDaysAgo),
    sealedDaysAgo == null ? null : daysAgo(sealedDaysAgo),
    batchId,
  );
  db.prepare('UPDATE records SET captured_at = ? WHERE batch_id = ?').run(daysAgo(capturedDaysAgo), batchId);
}

let phoneSeq = 0;
const nextPhone = () => `138${String(10000000 + ++phoneSeq).slice(-8)}`;

function makeRecords(n, builder) {
  return Array.from({ length: n }, (_, i) => builder(i));
}

export function seed({ dbFile = DB_FILE, reset = false } = {}) {
  if (reset && dbFile !== ':memory:') {
    mkdirSync(dirname(dbFile), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(dbFile + suffix);
      } catch {
        /* ignore */
      }
    }
  }
  const db = openDb(dbFile);
  // 空库才播种，避免重复插入
  if (db.prepare('SELECT COUNT(*) AS n FROM subjects').get().n > 0) {
    return { db, skipped: true };
  }

  /* ---------------- 主体 1：沈知微 ---------------- */
  insertSubject(db, 'sub_shen', '沈知微', 'App', '138****2210', daysAgo(210));

  L.applyConsentNotice(db, {
    subjectId: 'sub_shen',
    noticeKey: 'NTC-2026-0412-001',
    purposes: ['analytics', 'personalization', 'marketing'],
    scopes: ['contact', 'behavior', 'location_coarse', 'device_id'],
    retentionDays: 180,
    reason: '首次授权（注册引导页 v3）',
    source: 'consent-platform',
    effectiveAt: daysAgo(200),
  });

  const b1 = L.createBatch(db, {
    subjectId: 'sub_shen',
    source: 'App SDK 4.2',
    purpose: 'analytics',
    scopes: ['behavior', 'location_coarse'],
    fields: ['behavior', 'city'],
    records: makeRecords(42, () => ({
      behavior: ['浏览商品', '加入收藏', '搜索「露营帐篷」', '查看订单'][Math.floor(Math.random() * 4)],
      city: ['杭州', '上海', '南京'][Math.floor(Math.random() * 3)],
    })),
  });
  L.sealBatch(db, b1.batchId);
  backdateBatch(db, b1.batchId, { startedDaysAgo: 160, sealedDaysAgo: 158, capturedDaysAgo: 159 });

  const b2 = L.createBatch(db, {
    subjectId: 'sub_shen',
    source: 'App SDK 4.2',
    purpose: 'personalization',
    scopes: ['contact', 'behavior', 'location_coarse'],
    fields: ['contact', 'behavior', 'city'],
    records: makeRecords(128, () => ({
      contact: nextPhone(),
      behavior: ['首页推荐流曝光', '点击母婴频道', '加购奶粉', '领取优惠券'][Math.floor(Math.random() * 4)],
      city: ['杭州', '上海', '南京', '苏州'][Math.floor(Math.random() * 4)],
    })),
  });
  L.sealBatch(db, b2.batchId);
  backdateBatch(db, b2.batchId, { startedDaysAgo: 120, sealedDaysAgo: 117, capturedDaysAgo: 118 });

  const b3 = L.createBatch(db, {
    subjectId: 'sub_shen',
    source: 'Marketing Cloud',
    purpose: 'marketing',
    scopes: ['contact', 'behavior'],
    fields: ['contact', 'behavior'],
    records: makeRecords(36, () => ({
      contact: nextPhone(),
      behavior: ['短信点击', '活动页停留 32s', '未转化'][Math.floor(Math.random() * 3)],
    })),
  });
  L.sealBatch(db, b3.batchId);
  backdateBatch(db, b3.batchId, { startedDaysAgo: 90, sealedDaysAgo: 89, capturedDaysAgo: 89 });

  // 收窄：撤掉「个性化推荐」用途与「城市级位置」，保留 90 天
  const narrow = L.applyConsentNotice(db, {
    subjectId: 'sub_shen',
    noticeKey: 'NTC-2026-0811-004',
    purposes: ['analytics', 'marketing'],
    scopes: ['contact', 'behavior', 'device_id'],
    retentionDays: 90,
    reason: '用户在隐私中心关闭个性化推荐，并关闭城市级位置',
    source: 'consent-platform',
    effectiveAt: daysAgo(3),
  });

  // 中断：先跑一个批次就停，制造一个 paused 任务供恢复演示
  L.runJob(db, narrow.job.id, {
    chunkSize: 1,
    failAfter: 1,
    interruptMessage: '处置进程被重启，检查点已保存，等待恢复',
  });

  // 重复通知：同一 noticeKey 再来一次，应被幂等吸收
  L.applyConsentNotice(db, {
    subjectId: 'sub_shen',
    noticeKey: 'NTC-2026-0811-004',
    purposes: ['analytics', 'marketing'],
    scopes: ['contact', 'behavior', 'device_id'],
    retentionDays: 90,
    reason: '用户在隐私中心关闭个性化推荐，并关闭城市级位置',
  });

  /* ---------------- 主体 2：陆时安 ---------------- */
  insertSubject(db, 'sub_lu', '陆时安', '小程序', '186****7782', daysAgo(150));
  L.applyConsentNotice(db, {
    subjectId: 'sub_lu',
    noticeKey: 'NTC-2026-0318-017',
    purposes: ['service_quality', 'analytics'],
    scopes: ['contact', 'voice', 'behavior'],
    retentionDays: 365,
    reason: '客服回访授权',
    effectiveAt: daysAgo(140),
  });

  const l1 = L.createBatch(db, {
    subjectId: 'sub_lu',
    source: 'Call Center',
    purpose: 'service_quality',
    scopes: ['voice', 'contact'],
    fields: ['voice', 'contact'],
    records: makeRecords(24, (i) => ({
      voice: `call_rec_${String(i + 1).padStart(3, '0')}.wav`,
      contact: nextPhone(),
    })),
  });
  L.sealBatch(db, l1.batchId);
  backdateBatch(db, l1.batchId, { startedDaysAgo: 70, sealedDaysAgo: 69, capturedDaysAgo: 69 });

  const l2 = L.createBatch(db, {
    subjectId: 'sub_lu',
    source: '小程序埋点',
    purpose: 'analytics',
    scopes: ['behavior'],
    fields: ['behavior'],
    records: makeRecords(61, () => ({ behavior: ['工单提交', '评价页浏览', '联系客服'][Math.floor(Math.random() * 3)] })),
  });
  L.sealBatch(db, l2.batchId);
  backdateBatch(db, l2.batchId, { startedDaysAgo: 50, sealedDaysAgo: 49, capturedDaysAgo: 49 });

  // 撤回「语音记录」范围：高风险 -> 隔离
  const voiceNarrow = L.applyConsentNotice(db, {
    subjectId: 'sub_lu',
    noticeKey: 'NTC-2026-0902-021',
    purposes: ['service_quality', 'analytics'],
    scopes: ['contact', 'behavior'],
    retentionDays: 365,
    reason: '用户撤回通话录音授权',
    effectiveAt: daysAgo(1),
  });
  L.runJob(db, voiceNarrow.job.id, { chunkSize: 5 });

  /* ---------------- 主体 3：周予安 ---------------- */
  insertSubject(db, 'sub_zhou', '周予安', 'App', '159****3307', daysAgo(300));
  L.applyConsentNotice(db, {
    subjectId: 'sub_zhou',
    noticeKey: 'NTC-2026-0105-003',
    purposes: ['analytics', 'marketing'],
    scopes: ['contact', 'behavior', 'device_id'],
    retentionDays: 180,
    reason: '注册授权',
    effectiveAt: daysAgo(290),
  });
  const z1 = L.createBatch(db, {
    subjectId: 'sub_zhou',
    source: 'App SDK 4.2',
    purpose: 'marketing',
    scopes: ['contact', 'behavior'],
    fields: ['contact', 'behavior'],
    records: makeRecords(75, () => ({ contact: nextPhone(), behavior: ['Push 点击', '活动页浏览'][Math.floor(Math.random() * 2)] })),
  });
  L.sealBatch(db, z1.batchId);
  backdateBatch(db, z1.batchId, { startedDaysAgo: 200, sealedDaysAgo: 199, capturedDaysAgo: 199 });

  const z2 = L.createBatch(db, {
    subjectId: 'sub_zhou',
    source: 'App SDK 4.2',
    purpose: 'analytics',
    scopes: ['behavior', 'device_id'],
    fields: ['behavior', 'device_id'],
    records: makeRecords(90, () => ({ behavior: ['开屏曝光', '频道切换'], device_id: `dv-${Math.random().toString(36).slice(2, 10)}` })),
  });
  L.sealBatch(db, z2.batchId);
  backdateBatch(db, z2.batchId, { startedDaysAgo: 120, sealedDaysAgo: 119, capturedDaysAgo: 119 });

  const revoked = L.applyConsentNotice(db, {
    subjectId: 'sub_zhou',
    noticeKey: 'NTC-2026-1019-009',
    status: 'revoked',
    purposes: [],
    scopes: [],
    retentionDays: 0,
    reason: '用户行使删除权，撤回全部授权并要求删除已采集数据',
    effectiveAt: daysAgo(6),
  });
  L.runJob(db, revoked.job.id, { chunkSize: 10 });

  /* ---------------- 主体 4：许清和（保留期缩短） ---------------- */
  insertSubject(db, 'sub_xu', '许清和', '线下门店', '137****6519', daysAgo(400));
  L.applyConsentNotice(db, {
    subjectId: 'sub_xu',
    noticeKey: 'NTC-2025-1210-031',
    purposes: ['analytics', 'security'],
    scopes: ['contact', 'behavior', 'location_precise'],
    retentionDays: 365,
    reason: '门店会员授权',
    effectiveAt: daysAgo(380),
  });
  const x1 = L.createBatch(db, {
    subjectId: 'sub_xu',
    source: '门店 POS',
    purpose: 'analytics',
    scopes: ['behavior', 'location_precise'],
    fields: ['behavior', 'lat', 'lng'],
    records: makeRecords(58, () => ({
      behavior: ['到店消费', '扫码领券'],
      lat: Number((30.2 + Math.random() * 0.2).toFixed(5)),
      lng: Number((120.1 + Math.random() * 0.2).toFixed(5)),
    })),
  });
  L.sealBatch(db, x1.batchId);
  backdateBatch(db, x1.batchId, { startedDaysAgo: 200, sealedDaysAgo: 198, capturedDaysAgo: 199 });

  const x2 = L.createBatch(db, {
    subjectId: 'sub_xu',
    source: '门店 POS',
    purpose: 'security',
    scopes: ['contact'],
    fields: ['contact'],
    records: makeRecords(12, () => ({ contact: nextPhone() })),
  });
  L.sealBatch(db, x2.batchId);
  backdateBatch(db, x2.batchId, { startedDaysAgo: 30, sealedDaysAgo: 29, capturedDaysAgo: 29 });

  // 保留期 365 -> 120 天：需要清除超过 120 天的记录（待处置，不自动执行）
  L.applyConsentNotice(db, {
    subjectId: 'sub_xu',
    noticeKey: 'NTC-2026-1102-044',
    purposes: ['analytics', 'security'],
    scopes: ['contact', 'behavior', 'location_precise'],
    retentionDays: 120,
    reason: '监管口径调整：分析类数据保留期由 365 天缩短为 120 天',
    effectiveAt: daysAgo(0),
  });

  /* ---------------- 通知队列下发 ---------------- */
  L.flushNotices(db, { limit: 50 });

  return { db, skipped: false };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reset = process.argv.includes('--reset');
  const { skipped } = seed({ reset });
  console.log(skipped ? '数据库已有数据，跳过播种。' : `演示数据已写入：${DB_FILE}`);
  console.log('启动：npm start');
}
