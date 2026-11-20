import { tx } from './db.js';
import { sha256, canonicalJson, uniqueStrings, parseJson, nowIso, addDays, shortId } from './util.js';
import {
  PURPOSES,
  SCOPES,
  FIELD_SCOPE,
  JOB_TRIGGERS,
  ACTOR,
  purposeLabel,
  scopeLabel,
  termsSummary,
} from './meta.js';

/**
 * 授权快照数据接入层。
 *
 * 三条不变式：
 *  1. 快照不可变。任何授权变更都追加新版本，条款哈希 = 规范化后的 (用途, 范围, 保留期, 状态)。
 *  2. 批次只绑定创建时刻的快照。快照变化不回头改批次，而是生成处置任务。
 *  3. 处置必须落到数据本身。删除=物理清除；降级=抹除字段；隔离=迁出到 vault，
 *     查询层一律读不到，不能靠 WHERE 过滤伪装。
 */

export class LedgerError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const MAX_RETENTION_DAYS = 730;

export function computeTermsHash({ status, purposes, scopes, retentionDays }) {
  return sha256(
    canonicalJson({
      v: 1,
      status,
      purposes: [...purposes].sort(),
      scopes: [...scopes].sort(),
      retentionDays,
    }),
  );
}

export function normalizeTerms(input) {
  const status = input.status === 'revoked' ? 'revoked' : 'active';
  const purposes = uniqueStrings(input.purposes);
  const scopes = uniqueStrings(input.scopes);
  const retentionDays = Math.trunc(Number(input.retentionDays));
  if (status === 'active') {
    if (!purposes.length) throw new LedgerError('E_PURPOSES', '至少需要一个用途');
    const badP = purposes.filter((p) => !PURPOSES[p]);
    if (badP.length) throw new LedgerError('E_PURPOSES', `未知用途：${badP.join(', ')}`);
    if (!scopes.length) throw new LedgerError('E_SCOPES', '至少需要一个数据范围');
    const badS = scopes.filter((s) => !SCOPES[s]);
    if (badS.length) throw new LedgerError('E_SCOPES', `未知范围：${badS.join(', ')}`);
    if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS) {
      throw new LedgerError('E_RETENTION', `保留期限需在 1–${MAX_RETENTION_DAYS} 天之间`);
    }
  }
  return { status, purposes, scopes, retentionDays: status === 'revoked' ? 0 : retentionDays };
}

export function effectiveSnapshot(db, subjectId) {
  return db
    .prepare('SELECT * FROM snapshots WHERE subject_id = ? ORDER BY version DESC LIMIT 1')
    .get(subjectId);
}

export function getSnapshot(db, id) {
  return db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
}

export function snapshotView(row) {
  if (!row) return null;
  const purposes = parseJson(row.purposes, []);
  const scopes = parseJson(row.scopes, []);
  return {
    id: row.id,
    subjectId: row.subject_id,
    version: row.version,
    status: row.status,
    purposes,
    scopes,
    retentionDays: row.retention_days,
    termsHash: row.terms_hash,
    reason: row.reason,
    source: row.source,
    receivedAt: row.received_at,
    effectiveAt: row.effective_at,
    noticeKey: row.notice_key,
    prevId: row.prev_id,
    summary: termsSummary(purposes, scopes, row.retention_days, row.status),
  };
}

/* ------------------------------------------------------------------ */
/* 授权快照写入                                                         */
/* ------------------------------------------------------------------ */

/**
 * 幂等接收一条授权通知。相同 notice_key 重复到达时返回首次结果，不重复建快照/任务。
 * 同一主体的相同条款再次到达（不同 notice_key）也会被识别为重复，不产生新版本。
 */
export function applyConsentNotice(db, payload) {
  const subjectId = String(payload.subjectId ?? '').trim();
  const noticeKey = String(payload.noticeKey ?? '').trim();
  if (!subjectId) throw new LedgerError('E_SUBJECT', '缺少 subjectId', 400);
  if (!noticeKey) throw new LedgerError('E_NOTICE_KEY', '缺少 noticeKey');
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
  if (!subject) throw new LedgerError('E_SUBJECT_NOT_FOUND', `主体不存在：${subjectId}`, 404);

  const terms = normalizeTerms({
    status: payload.status ?? 'active',
    purposes: payload.purposes ?? [],
    scopes: payload.scopes ?? [],
    retentionDays: payload.retentionDays ?? 0,
  });
  const termsHash = computeTermsHash(terms);

  return tx(db, () => {
    const seen = db.prepare('SELECT * FROM consent_notices WHERE notice_key = ?').get(noticeKey);
    if (seen) {
      if (seen.subject_id !== subjectId) {
        // 同一 noticeKey 指向另一个主体：上游串号，绝不能当成重复通知静默吞掉。
        throw new LedgerError(
          'E_NOTICE_SUBJECT_CONFLICT',
          `通知 ${noticeKey} 已用于主体 ${seen.subject_id}，不能再用于 ${subjectId}`,
          409,
        );
      }
      return {
        outcome: 'duplicate_notice',
        noticeKey,
        snapshot: snapshotView(getSnapshot(db, seen.snapshot_id)),
        job: null,
        message: '该通知已处理过，未重复生成快照与处置任务',
      };
    }

    const current = effectiveSnapshot(db, subjectId);
    if (current && current.terms_hash === termsHash && current.status === terms.status) {
      recordConsentNotice(db, subjectId, noticeKey, payload, 'duplicate_terms', current.id);
      audit(db, {
        action: 'consent.notice.duplicate',
        subjectId,
        snapshotId: current.id,
        summary: `重复通知 ${noticeKey}：条款与 v${current.version} 一致，未生成新版本`,
        detail: { noticeKey, termsHash },
      });
      const notice = queueSubjectNotice(db, {
        subjectId,
        snapshotId: current.id,
        template: 'consent_duplicate_suppressed',
        dedupeKey: `notice:dup:${subjectId}:${termsHash}`,
        status: 'suppressed',
      });
      return {
        outcome: 'duplicate_terms',
        noticeKey,
        snapshot: snapshotView(current),
        job: null,
        notificationSuppressed: true,
        message: `条款与当前 v${current.version} 完全一致，按重复通知处理，未重复下发通知`,
        noticeRecorded: notice.created,
      };
    }

    const version = (current?.version ?? 0) + 1;
    const snapshotId = shortId('snap');
    const receivedAt = nowIso();
    const effectiveAt = payload.effectiveAt ?? receivedAt;
    const reason = String(payload.reason ?? '授权平台同步').slice(0, 500);

    db.prepare(
      `INSERT INTO snapshots
       (id, subject_id, version, status, purposes, scopes, retention_days, terms_hash,
        reason, source, received_at, effective_at, notice_key, prev_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      snapshotId,
      subjectId,
      version,
      terms.status,
      JSON.stringify(terms.purposes),
      JSON.stringify(terms.scopes),
      terms.retentionDays,
      termsHash,
      reason,
      String(payload.source ?? 'consent-platform'),
      receivedAt,
      effectiveAt,
      noticeKey,
      current?.id ?? null,
    );

    recordConsentNotice(db, subjectId, noticeKey, payload, 'accepted', snapshotId);

    const snapshotRow = getSnapshot(db, snapshotId);
    audit(db, {
      action: 'consent.snapshot.created',
      subjectId,
      snapshotId,
      summary: `授权快照 v${version}：${termsSummary(terms.purposes, terms.scopes, terms.retentionDays, terms.status)}`,
      detail: { noticeKey, termsHash, reason, prevId: current?.id ?? null },
    });

    const job = planDispositionForSnapshotChange(db, current, snapshotRow);
    return {
      outcome: 'accepted',
      noticeKey,
      snapshot: snapshotView(snapshotRow),
      job: job ? jobView(db, job.id) : null,
      message: job
        ? `快照 v${version} 已生效，生成处置任务 ${job.id}`
        : `快照 v${version} 已生效，无需处置已入库数据`,
    };
  });
}

function recordConsentNotice(db, subjectId, noticeKey, payload, outcome, snapshotId) {
  db.prepare(
    `INSERT INTO consent_notices (id, subject_id, notice_key, payload, outcome, snapshot_id, received_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(shortId('ntc'), subjectId, noticeKey, JSON.stringify(payload), outcome, snapshotId, nowIso());
}

/* ------------------------------------------------------------------ */
/* 批次接入                                                             */
/* ------------------------------------------------------------------ */

export function createBatch(db, input) {
  const subjectId = String(input.subjectId ?? '');
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
  if (!subject) throw new LedgerError('E_SUBJECT_NOT_FOUND', `主体不存在：${subjectId}`, 404);

  const purpose = String(input.purpose ?? '');
  const scopes = uniqueStrings(input.scopes ?? []);
  const fields = uniqueStrings(input.fields ?? []);
  const requestedRetention = Math.trunc(Number(input.retentionDays ?? 0));
  const source = String(input.source ?? 'app-sdk');

  if (!PURPOSES[purpose]) throw new LedgerError('E_PURPOSE', '请选择合法的采集用途');
  if (!scopes.length) throw new LedgerError('E_SCOPES', '请至少选择一个采集范围');
  const badS = scopes.filter((s) => !SCOPES[s]);
  if (badS.length) throw new LedgerError('E_SCOPES', `未知范围：${badS.join(', ')}`);
  if (!fields.length) throw new LedgerError('E_FIELDS', '请至少提供一个数据字段');

  // 字段必须落在所选范围的映射内——避免"声明了城市级，实际传了经纬度"。
  const allowedFields = new Set(scopes.flatMap((s) => SCOPES[s].fields));
  const stray = fields.filter((f) => !allowedFields.has(f));
  if (stray.length) {
    throw new LedgerError('E_FIELDS', `字段 ${stray.join(', ')} 不属于所选范围`, 400, {
      allowedFields: [...allowedFields],
    });
  }

  const batchId = shortId('bat');
  const startedAt = nowIso();

  return tx(db, () => {
    const snapRow = effectiveSnapshot(db, subjectId);
    if (!snapRow) {
      throw new LedgerError('E_NO_CONSENT', '该主体没有有效授权快照，拒绝采集', 409);
    }
    const snapshot = snapshotView(snapRow);

    if (snapshot.status === 'revoked') {
      const reason = '授权已撤回，拒绝新建采集批次';
      insertBlockedBatch(db, {
        batchId,
        input,
        subjectId,
        purpose,
        scopes,
        fields,
        requestedRetention,
        source,
        startedAt,
        snapshot,
        code: 'CONSENT_REVOKED',
        reason,
      });
      audit(db, {
        action: 'ingest.blocked',
        subjectId,
        batchId,
        snapshotId: snapshot.id,
        summary: `阻断采集：${reason}`,
        detail: { purpose, scopes, fields, snapshotVersion: snapshot.version },
      });
      return { status: 'blocked', batchId, code: 'CONSENT_REVOKED', reason, snapshot };
    }

    // 用途/范围必须被当前授权覆盖；保留期不能超过授权上限。
    const missingPurposes = [purpose].filter((p) => !snapshot.purposes.includes(p));
    const missingScopes = scopes.filter((s) => !snapshot.scopes.includes(s));
    const retention = requestedRetention > 0 ? requestedRetention : snapshot.retentionDays;
    const overRetention = retention > snapshot.retentionDays;

    if (missingPurposes.length || missingScopes.length || overRetention) {
      const parts = [];
      if (missingPurposes.length) parts.push(`用途「${purposeLabel(purpose)}」未授权`);
      if (missingScopes.length) parts.push(`范围「${missingScopes.map(scopeLabel).join('、')}」未授权`);
      if (overRetention) parts.push(`保留 ${retention} 天超过授权上限 ${snapshot.retentionDays} 天`);
      const reason = parts.join('；');
      insertBlockedBatch(db, {
        batchId,
        input,
        subjectId,
        purpose,
        scopes,
        fields,
        requestedRetention: retention,
        source,
        startedAt,
        snapshot,
        code: overRetention && !missingPurposes.length && !missingScopes.length
          ? 'RETENTION_EXCEEDS'
          : 'SCOPE_NOT_GRANTED',
        reason,
      });
      audit(db, {
        action: 'ingest.blocked',
        subjectId,
        batchId,
        snapshotId: snapshot.id,
        summary: `阻断采集：${reason}`,
        detail: {
          purpose,
          scopes,
          requestedRetention: retention,
          snapshotVersion: snapshot.version,
        },
      });
      return { status: 'blocked', batchId, code: overRetention ? 'RETENTION_EXCEEDS' : 'SCOPE_NOT_GRANTED', reason, snapshot };
    }

    db.prepare(
      `INSERT INTO batches
       (id, subject_id, source, purpose, scopes, fields, retention_days, snapshot_id,
        snapshot_version, terms_hash, status, compliance, requested_retention,
        record_count, started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'collecting','ok',?,0,?)`,
    ).run(
      batchId,
      subjectId,
      source,
      purpose,
      JSON.stringify(scopes),
      JSON.stringify(fields),
      retention,
      snapshot.id,
      snapshot.version,
      snapshot.termsHash,
      requestedRetention > 0 ? requestedRetention : null,
      startedAt,
    );

    audit(db, {
      action: 'batch.created',
      subjectId,
      batchId,
      snapshotId: snapshot.id,
      summary: `批次绑定授权快照 v${snapshot.version}（${purposeLabel(purpose)} / ${scopes
        .map(scopeLabel)
        .join('、')} / 保留 ${retention} 天）`,
      detail: { fields, termsHash: snapshot.termsHash },
    });

    const records = Array.isArray(input.records) ? input.records : [];
    if (records.length) appendRecords(db, batchId, records);
    return { status: 'collecting', batchId, snapshot, recordCount: records.length };
  });
}

function insertBlockedBatch(db, opts) {
  const { batchId, input, subjectId, purpose, scopes, fields, requestedRetention, source, startedAt, snapshot, code, reason } = opts;
  db.prepare(
    `INSERT INTO batches
     (id, subject_id, source, purpose, scopes, fields, retention_days, snapshot_id,
      snapshot_version, terms_hash, status, block_code, block_reason, compliance,
      requested_retention, record_count, started_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'blocked',?,?,?,?,0,?)`,
  ).run(
    batchId,
    subjectId,
    source,
    purpose,
    JSON.stringify(scopes),
    JSON.stringify(fields),
    Math.max(requestedRetention || snapshot.retentionDays, 0),
    snapshot.id,
    snapshot.version,
    snapshot.termsHash,
    code,
    reason,
    snapshot.status === 'revoked' ? 'revoked' : 'overbroad',
    requestedRetention || null,
    startedAt,
  );
  void input;
}

export function appendRecords(db, batchId, records) {
  return tx(db, () => {
    const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
    if (!batch) throw new LedgerError('E_BATCH_NOT_FOUND', '批次不存在', 404);
    if (batch.status !== 'collecting') {
      throw new LedgerError(
        'E_BATCH_CLOSED',
        `批次状态为 ${batch.status}，不能再写入记录`,
        409,
      );
    }
    const snapshot = snapshotView(getSnapshot(db, batch.snapshot_id));
    if (!snapshot || snapshot.status === 'revoked') {
      sealBatchCore(db, batchId, 'blocked', {
        code: 'CONSENT_REVOKED',
        reason: '写入时发现授权已撤回',
      });
      throw new LedgerError('E_CONSENT_REVOKED', '授权已撤回，写入被阻断', 409);
    }

    const fields = parseJson(batch.fields, []);
    const at = nowIso();
    const insert = db.prepare(
      `INSERT INTO records (batch_id, subject_id, payload, captured_at, state, state_reason, state_job, updated_at)
       VALUES (?,?,?,?, 'live', NULL, NULL, ?)`,
    );
    let lastId = 0;
    for (const rec of records) {
      const payload = {};
      for (const f of fields) {
        if (rec[f] !== undefined && rec[f] !== null && rec[f] !== '') payload[f] = rec[f];
      }
      if (!Object.keys(payload).length) continue;
      const res = insert.run(batchId, batch.subject_id, JSON.stringify(payload), at, at);
      lastId = Number(res.lastInsertRowid);
    }
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM records WHERE batch_id = ?')
      .get(batchId);
    db.prepare('UPDATE batches SET record_count = ? WHERE id = ?').run(n, batchId);
    return { batchId, added: records.length, recordCount: n, lastRecordId: lastId };
  });
}

export function sealBatch(db, batchId, opts = {}) {
  return tx(db, () => {
    const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
    if (!batch) throw new LedgerError('E_BATCH_NOT_FOUND', '批次不存在', 404);
    const snapshot = snapshotView(getSnapshot(db, batch.snapshot_id));

    // 封存时重新对照当前授权。批次可能在采集过程中被收窄/撤回。
    const current = snapshotView(effectiveSnapshot(db, batch.subject_id));
    if (current && current.status === 'revoked') {
      sealBatchCore(db, batchId, 'blocked', {
        code: 'CONSENT_REVOKED',
        reason: '封存时授权已撤回，批次转为阻断并等待处置',
      });
      return { status: 'blocked', code: 'CONSENT_REVOKED' };
    }
    if (current && current.id !== snapshot.id) {
      const violation = batchViolations(db, batch, batch.fields, current);
      if (violation) {
        db.prepare('UPDATE batches SET flagged_at = ?, flagged_by_snapshot = ? WHERE id = ?').run(
          nowIso(),
          current.id,
          batchId,
        );
        audit(db, {
          action: 'batch.flagged',
          subjectId: batch.subject_id,
          batchId,
          snapshotId: current.id,
          summary: `封存时发现批次超出当前授权：${violation}`,
          detail: { snapshotVersion: current.version },
        });
      }
    }
    sealBatchCore(db, batchId, 'sealed', {});
    return { status: 'sealed' };
  });
}

function sealBatchCore(db, batchId, status, { code, reason }) {
  db.prepare(
    `UPDATE batches SET status = ?, sealed_at = ?, block_code = ?, block_reason = ?
     WHERE id = ?`,
  ).run(status, nowIso(), code ?? null, reason ?? null, batchId);
  const b = db.prepare('SELECT subject_id FROM batches WHERE id = ?').get(batchId);
  audit(db, {
    action: status === 'sealed' ? 'batch.sealed' : 'batch.blocked',
    subjectId: b.subject_id,
    batchId,
    summary: status === 'sealed' ? '批次封存，记录进入可查询状态' : `批次阻断：${reason}`,
    detail: {},
  });
}

/* ------------------------------------------------------------------ */
/* 快照差异 -> 处置计划                                                  */
/* ------------------------------------------------------------------ */

export function diffSnapshots(prev, next) {
  const prevP = prev ? parseJson(prev.purposes, []) : [];
  const prevS = prev ? parseJson(prev.scopes, []) : [];
  const nextP = next ? parseJson(next.purposes, []) : [];
  const nextS = next ? parseJson(next.scopes, []) : [];
  return {
    removedPurposes: prevP.filter((p) => !nextP.includes(p)),
    removedScopes: prevS.filter((s) => !nextS.includes(s)),
    addedPurposes: nextP.filter((p) => !prevP.includes(p)),
    addedScopes: nextS.filter((s) => !prevS.includes(s)),
    prevRetention: prev?.retention_days ?? null,
    nextRetention: next?.retention_days ?? null,
    retentionShrunk:
      next && prev && next.status === 'active' && next.retention_days < prev.retention_days,
    revoked: next?.status === 'revoked',
    widened:
      !!next &&
      next.status === 'active' &&
      (prev?.status === 'revoked' ||
        nextP.some((p) => !prevP.includes(p)) ||
        nextS.some((s) => !prevS.includes(s))),
  };
}

function batchViolations(db, batch, fieldsJson, snapshot) {
  const purposeOk = snapshot.purposes.includes(batch.purpose);
  const scopes = parseJson(batch.scopes, []);
  const fields = parseJson(fieldsJson, []);
  const lostScopes = scopes.filter((s) => !snapshot.scopes.includes(s));
  const lostFields = fields.filter((f) => !snapshot.scopes.includes(FIELD_SCOPE[f]));
  const retentionOver = batch.retention_days > snapshot.retentionDays;
  if (purposeOk && !lostScopes.length && !retentionOver) return null;
  const parts = [];
  if (!purposeOk) parts.push('用途失权');
  if (lostScopes.length) parts.push(`范围失权：${lostScopes.map(scopeLabel).join('、')}`);
  if (retentionOver) parts.push(`保留期超出 ${snapshot.retentionDays} 天`);
  return parts.join('；');
}

/**
 * 决定一个批次在新授权下应如何处置。
 *  - 用途失权 / 授权撤回 / 主体级删除请求 -> delete（整批物理清除）
 *  - 部分范围失权 -> degrade（抹掉失权字段，保住仍授权部分）或 quarantine
 *  - 仅保留期缩短 -> 不需要立即动批次，交给留存清理
 */
export function decideBatchAction(db, batch, snapshot, diff) {
  const scopes = parseJson(batch.scopes, []);
  const fields = parseJson(batch.fields, []);
  const retentionOver = batch.retention_days > snapshot.retentionDays;

  if (snapshot.status === 'revoked') {
    return { action: 'delete', kind: 'consent_revoked', reason: '授权被整体撤回，依据撤回请求物理删除' };
  }
  const purposeOk = snapshot.purposes.includes(batch.purpose);
  if (!purposeOk) {
    return {
      action: 'delete',
      kind: 'purpose_revoked',
      reason: `用途「${purposeLabel(batch.purpose)}」已不在授权范围，整批数据须删除`,
      removedPurposes: diff.removedPurposes,
    };
  }
  const lostScopes = scopes.filter((s) => !snapshot.scopes.includes(s));
  const lostFields = fields.filter((f) => !snapshot.scopes.includes(FIELD_SCOPE[f]));
  const remainingFields = fields.filter((f) => snapshot.scopes.includes(FIELD_SCOPE[f]));

  if (lostFields.length) {
    if (!remainingFields.length) {
      return {
        action: 'delete',
        kind: 'scope_revoked_full',
        reason: `批次全部字段所属范围均失权（${lostScopes.map(scopeLabel).join('、')}），整批删除`,
        removedScopes: lostScopes,
        removedFields: lostFields,
      };
    }
    if (SCOPES[FIELD_SCOPE[lostFields[0]]]?.risk === 'high' || lostScopes.some((s) => SCOPES[s].risk === 'high')) {
      // 高风险字段：不留在可查询面，迁入隔离区，法务/合规复核后才释放或清除。
      return {
        action: 'quarantine',
        kind: 'scope_revoked_sensitive',
        reason: `高风险范围失权（${lostScopes.map(scopeLabel).join('、')}），批次迁入隔离区`,
        removedScopes: lostScopes,
        removedFields: lostFields,
      };
    }
    return {
      action: 'degrade',
      kind: 'scope_revoked_partial',
      reason: `部分范围失权（${lostScopes.map(scopeLabel).join('、')}），保留授权字段、抹除失权字段`,
      removedScopes: lostScopes,
      removedFields: lostFields,
    };
  }
  if (retentionOver) {
    // 保留期缩短：超出新期限的记录按采集时间立即清除，其余保留。
    const cutoff = addDays(new Date().toISOString(), -snapshot.retentionDays);
    const expired = db
      .prepare(`SELECT COUNT(*) AS n FROM records WHERE batch_id = ? AND captured_at < ?`)
      .get(batch.id, cutoff).n;
    if (!expired) return { action: 'none', kind: 'no_impact', reason: '该批次没有超出新保留期的记录' };
    return {
      action: 'delete',
      kind: 'retention_shortened',
      reason: `保留期由 ${batch.retention_days} 天缩短为 ${snapshot.retentionDays} 天，清除 ${expired} 条超期记录`,
      cutoff,
    };
  }
  return { action: 'none', kind: 'no_impact', reason: '该批次仍在授权范围内', removedScopes: [], removedFields: [] };
}

export function planDispositionForSnapshotChange(db, prevRow, nextRow) {
  const prev = prevRow ? snapshotView(prevRow) : null;
  const next = snapshotView(nextRow);
  const diff = diffSnapshots(prevRow, nextRow);
  const isNarrowing =
    diff.revoked || diff.removedPurposes.length || diff.removedScopes.length || diff.retentionShrunk;

  if (!isNarrowing && !diff.widened) return null;
  if (!isNarrowing) {
    audit(db, {
      action: 'consent.widened',
      subjectId: next.subjectId,
      snapshotId: next.id,
      summary: `授权放宽至 v${next.version}，新批次可按新范围采集；历史批次不受影响`,
      detail: diff,
    });
    return null;
  }

  const trigger = diff.revoked
    ? 'consent_revoked'
    : diff.retentionShrunk && !diff.removedPurposes.length && !diff.removedScopes.length
      ? 'retention_policy'
      : 'consent_narrowed';
  // 幂等键：主体 + 触发 + 目标快照。同一快照重复计算只会命中已有任务。
  const dedupeKey = `disp:${next.subjectId}:${trigger}:${next.id}`;
  const existing = db.prepare('SELECT * FROM jobs WHERE dedupe_key = ?').get(dedupeKey);
  if (existing) {
    audit(db, {
      action: 'disposition.deduped',
      subjectId: next.subjectId,
      jobId: existing.id,
      snapshotId: next.id,
      summary: `命中已有处置任务 ${existing.id}，未重复创建`,
      detail: { dedupeKey },
    });
    return existing;
  }

  const jobId = shortId('job');
  const now = nowIso();

  // 找出仍持有数据、且不是由该快照建立的批次。阻断批次从未入库、隔离批次已迁出，均不再处置。
  // 例外：整体撤回时，隔离区里的副本也必须清除（法务保全的除外，执行器会跳过）。
  const candidates = db
    .prepare(
      `SELECT * FROM batches
        WHERE subject_id = ?
          AND (status IN ('collecting','sealed','degraded') OR (? = 1 AND status = 'quarantined'))
          AND (flagged_by_snapshot IS NULL OR flagged_by_snapshot != ?)
        ORDER BY started_at ASC`,
    )
    .all(next.subjectId, diff.revoked ? 1 : 0, next.id);

  const targets = [];
  for (const batch of candidates) {
    const decision = decideBatchAction(db, batch, next, diff);
    if (decision.action === 'none') continue;
    targets.push({
      batchId: batch.id,
      action: decision.action,
      kind: decision.kind,
      reason: decision.reason,
      removedScopes: decision.removedScopes ?? [],
      removedFields: decision.removedFields ?? [],
      cutoff: decision.cutoff ?? null,
      recordCount: batch.record_count,
    });
  }

  let primary = 'none';
  if (targets.length) {
    const actions = new Set(targets.map((t) => t.action));
    primary = actions.size === 1 ? [...actions][0] : 'mixed';
  }

  db.prepare(
    `INSERT INTO jobs
     (id, subject_id, trigger, from_snapshot_id, to_snapshot_id, dedupe_key, status, action,
      impacted_batch_ids, total_batches, total_records, created_at, updated_at, notes)
     VALUES (?,?,?,?,?,?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    next.subjectId,
    trigger,
    prev?.id ?? null,
    next.id,
    dedupeKey,
    primary,
    JSON.stringify(targets.map((t) => t.batchId)),
    targets.length,
    targets.reduce((acc, t) => acc + t.recordCount, 0),
    now,
    now,
    targets.length ? null : '没有需要处置的历史批次',
  );

  const ins = db.prepare(
    `INSERT INTO job_targets
     (job_id, batch_id, ord, action, kind, reason, removed_scopes, removed_fields,
      cutoff, before_state, status, records_seen, records_done, detail)
     VALUES (?,?,?,?,?,?,?,?,?, ?, 'pending', ?, 0, NULL)`,
  );
  targets.forEach((t, i) => {
    ins.run(
      jobId,
      t.batchId,
      i,
      t.action,
      t.kind,
      t.reason,
      JSON.stringify(t.removedScopes),
      JSON.stringify(t.removedFields),
      t.cutoff,
      'live',
      t.recordCount,
    );
  });

  audit(db, {
    action: 'disposition.planned',
    subjectId: next.subjectId,
    jobId,
    snapshotId: next.id,
    summary: `依据 v${next.version} 生成处置任务：${targets.length} 个受影响批次，动作 ${primary}`,
    detail: { trigger, diff, targets },
  });

  if (targets.length) {
    queueSubjectNotice(db, {
      subjectId: next.subjectId,
      snapshotId: next.id,
      jobId,
      template: trigger === 'consent_revoked' ? 'consent_revoked_notice' : 'consent_narrowed_notice',
      dedupeKey: `notice:job:${jobId}`,
    });
  } else {
    db.prepare(
      `UPDATE jobs SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(now, now, jobId);
  }
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
}

/* ------------------------------------------------------------------ */
/* 处置执行器：分块、可暂停、可恢复                                       */
/* ------------------------------------------------------------------ */

export function jobView(db, jobId) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!row) return null;
  const subject = db.prepare('SELECT name FROM subjects WHERE id = ?').get(row.subject_id);
  const targets = db
    .prepare('SELECT * FROM job_targets WHERE job_id = ? ORDER BY ord ASC')
    .all(jobId)
    .map((t) => {
      const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(t.batch_id);
      return {
        batchId: t.batch_id,
        ord: t.ord,
        action: t.action,
        kind: t.kind,
        reason: t.reason,
        removedScopes: parseJson(t.removed_scopes, []),
        removedFields: parseJson(t.removed_fields, []),
        cutoff: t.cutoff ?? null,
        beforeState: t.before_state,
        status: t.status,
        recordsSeen: t.records_seen,
        recordsDone: t.records_done,
        processedAt: t.processed_at,
        detail: parseJson(t.detail, null),
        batchStatus: batch?.status ?? 'deleted',
        purpose: batch?.purpose ?? null,
        snapshotVersion: batch?.snapshot_version ?? null,
        startedAt: batch?.started_at ?? null,
        recordCount: batch?.record_count ?? 0,
        legalHold: !!batch?.legal_hold,
      };
    });
  const done = targets.filter((t) => t.status === 'done' || t.status === 'skipped').length;
  const from = row.from_snapshot_id ? snapshotView(getSnapshot(db, row.from_snapshot_id)) : null;
  const to = snapshotView(getSnapshot(db, row.to_snapshot_id));
  return {
    id: row.id,
    subjectId: row.subject_id,
    subjectName: subject?.name ?? row.subject_id,
    trigger: row.trigger,
    triggerLabel: JOB_TRIGGERS[row.trigger] ?? row.trigger,
    fromSnapshot: from,
    toSnapshot: to,
    dedupeKey: row.dedupe_key,
    status: row.status,
    action: row.action,
    impactedBatchIds: parseJson(row.impacted_batch_ids, []),
    processedBatches: row.processed_batches,
    processedRecords: row.processed_records,
    totalBatches: row.total_batches,
    totalRecords: row.total_records,
    targetsDone: done,
    attempts: row.attempts,
    checkpoint: parseJson(row.checkpoint, null),
    lastError: row.last_error,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    targets,
    diff: diffSnapshots(
      row.from_snapshot_id ? getSnapshot(db, row.from_snapshot_id) : null,
      getSnapshot(db, row.to_snapshot_id),
    ),
  };
}

/**
 * 执行一个任务，每次处理 `chunkSize` 个批次后停下。
 * 进展写 checkpoint + 行级 status，进程中断后 `resumeJob` 从下一个 pending 目标继续。
 * `failAfter` / `failOnBatch` 仅供测试注入故障。
 */
export function runJob(db, jobId, opts = {}) {
  const chunkSize = Math.max(1, Number(opts.chunkSize ?? 3));
  const maxChunks = Math.max(1, Number(opts.maxChunks ?? 1000));
  const failAfter = opts.failAfter ?? null; // 处理 N 个批次后抛错，模拟中断/失败
  const failOnBatch = opts.failOnBatch ?? null;
  const actorName = opts.actor ?? '系统处置器';

  let job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw new LedgerError('E_JOB_NOT_FOUND', '任务不存在', 404);
  if (job.status === 'completed') return { job: jobView(db, jobId), ran: 0, alreadyComplete: true };
  if (job.status === 'cancelled') throw new LedgerError('E_JOB_CANCELLED', '任务已取消', 409);
  if (job.status === 'paused' && !opts.resume) {
    throw new LedgerError('E_JOB_PAUSED', '任务已暂停，需显式恢复后才会继续', 409);
  }

  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(job.subject_id);
  const snapshot = snapshotView(getSnapshot(db, job.to_snapshot_id));

  const markRunning = () => {
    db.prepare(
      `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?),
        attempts = attempts + 1, updated_at = ?, last_error = NULL WHERE id = ?`,
    ).run(nowIso(), nowIso(), jobId);
  };
  markRunning();
  audit(db, {
    action: 'disposition.started',
    subjectId: job.subject_id,
    jobId,
    snapshotId: job.to_snapshot_id,
    summary: `${opts.resume ? '恢复' : '开始'}执行处置任务（目标快照 v${snapshot?.version}）`,
    detail: { chunkSize, retry: !!opts.resume },
  });

  let ran = 0;
  let chunks = 0;
  let failure = null;

  while (chunks < maxChunks) {
    const pending = db
      .prepare(
        `SELECT t.*, b.status AS batch_status, b.legal_hold AS batch_hold
           FROM job_targets t JOIN batches b ON b.id = t.batch_id
          WHERE t.job_id = ? AND t.status = 'pending'
          ORDER BY t.ord ASC LIMIT ?`,
      )
      .all(jobId, chunkSize);
    if (!pending.length) break;
    chunks += 1;

    for (const target of pending) {
      if (failOnBatch && target.batch_id === failOnBatch) {
        failure = new Error(`注入故障：批次 ${target.batch_id} 处理失败`);
        break;
      }
      try {
        executeTarget(db, { job, target, snapshot, subject, actor: actorName });
        ran += 1;
      } catch (err) {
        failure = err;
        db.prepare(
          `UPDATE job_targets SET status = 'failed', detail = ?, processed_at = ? WHERE job_id = ? AND batch_id = ?`,
        ).run(JSON.stringify({ error: String(err.message) }), nowIso(), jobId, target.batch_id);
        break;
      }
      if (failAfter != null && ran >= failAfter) {
        failure = new Error(opts.interruptMessage ?? `注入中断：已处理 ${ran} 个批次后停止`);
        break;
      }
    }
    if (failure) break;

    updateJobProgress(db, jobId);
  }

  updateJobProgress(db, jobId);
  const after = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);

  if (failure) {
    db.prepare(
      `UPDATE jobs SET status = 'paused', last_error = ?, updated_at = ?, checkpoint = ? WHERE id = ?`,
    ).run(
      String(failure.message),
      nowIso(),
      JSON.stringify({
        at: nowIso(),
        processedBatches: after.processed_batches,
        processedRecords: after.processed_records,
        nextOrd: nextPendingOrd(db, jobId),
      }),
      jobId,
    );
    audit(db, {
      action: 'disposition.paused',
      subjectId: job.subject_id,
      jobId,
      summary: `处置中断并暂停：${failure.message}（已完成 ${after.processed_batches}/${after.total_batches} 批）`,
      detail: { error: String(failure.message), checkpoint: parseJson(after.checkpoint, null) },
    });
    return { job: jobView(db, jobId), ran, error: String(failure.message) };
  }

  const remaining = db
    .prepare(`SELECT COUNT(*) AS n FROM job_targets WHERE job_id = ? AND status = 'pending'`)
    .get(jobId).n;

  if (remaining === 0) {
    db.prepare(
      `UPDATE jobs SET status = 'completed', completed_at = ?, updated_at = ?, checkpoint = NULL
       WHERE id = ?`,
    ).run(nowIso(), nowIso(), jobId);
    audit(db, {
      action: 'disposition.completed',
      subjectId: job.subject_id,
      jobId,
      summary: `处置完成：${after.processed_batches} 个批次 / ${after.processed_records} 条记录`,
      detail: {},
    });
  } else {
    db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(nowIso(), jobId);
  }
  return { job: jobView(db, jobId), ran };
}

function nextPendingOrd(db, jobId) {
  const row = db
    .prepare(
      `SELECT MIN(ord) AS ord FROM job_targets WHERE job_id = ? AND status = 'pending'`,
    )
    .get(jobId);
  return row?.ord ?? null;
}

function updateJobProgress(db, jobId) {
  const agg = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('done','skipped') THEN 1 ELSE 0 END) AS batches,
         SUM(CASE WHEN status IN ('done','skipped') THEN records_done ELSE 0 END) AS records
       FROM job_targets WHERE job_id = ?`,
    )
    .get(jobId);
  db.prepare('UPDATE jobs SET processed_batches = ?, processed_records = ?, updated_at = ? WHERE id = ?').run(
    agg.batches ?? 0,
    agg.records ?? 0,
    nowIso(),
    jobId,
  );
}

function executeTarget(db, { job, target, snapshot, subject, actor }) {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(target.batch_id);
  if (!batch) {
    db.prepare(
      `UPDATE job_targets SET status = 'skipped', detail = ?, processed_at = ? WHERE job_id = ? AND batch_id = ?`,
    ).run(JSON.stringify({ reason: '批次已不存在' }), nowIso(), job.id, target.batch_id);
    return;
  }

  if (batch.legal_hold) {
    db.prepare(
      `UPDATE job_targets SET status = 'skipped', detail = ?, processed_at = ? WHERE job_id = ? AND batch_id = ?`,
    ).run(
      JSON.stringify({ reason: '法务保全中，处置暂缓并升级人工审批' }),
      nowIso(),
      job.id,
      target.batch_id,
    );
    audit(db, {
      action: 'disposition.skipped_hold',
      subjectId: batch.subject_id,
      jobId: job.id,
      batchId: batch.id,
      summary: `批次处于法务保全，跳过 ${target.action}`,
      detail: { reason: batch.hold_reason },
    });
    return;
  }

  const removedFields = parseJson(target.removed_fields, []);
  const removedScopes = parseJson(target.removed_scopes, []);

  if (target.action === 'delete') {
    const cutoff = target.cutoff ?? null;
    // 物理删除：先删记录再打批次标记；vault 里若有同批副本一并清除。
    const recs = cutoff
      ? db
          .prepare('SELECT COUNT(*) AS n FROM records WHERE batch_id = ? AND captured_at < ?')
          .get(batch.id, cutoff).n
      : db.prepare('SELECT COUNT(*) AS n FROM records WHERE batch_id = ?').get(batch.id).n;
    if (cutoff) {
      db.prepare('DELETE FROM records WHERE batch_id = ? AND captured_at < ?').run(batch.id, cutoff);
      purgeVaultForBatch(db, batch.id, '授权处置：保留期缩短，清除超期副本');
      const left = db.prepare('SELECT COUNT(*) AS n FROM records WHERE batch_id = ?').get(batch.id).n;
      db.prepare(
        `UPDATE batches SET retention_days = ?, record_count = ?, disposed_action = 'retention',
          disposed_at = ?, disposed_by_job = ? WHERE id = ?`,
      ).run(snapshot.retentionDays, left, nowIso(), job.id, batch.id);
      markTargetDone(db, job.id, batch.id, recs, recs, { action: 'retention', deletedRecords: recs, cutoff });
      audit(db, {
        action: 'disposition.retention.applied',
        subjectId: batch.subject_id,
        jobId: job.id,
        batchId: batch.id,
        summary: `保留期缩短：批次 ${batch.id} 清除 ${recs} 条超期记录，剩余 ${left} 条`,
        detail: { cutoff, newRetentionDays: snapshot.retentionDays, reason: target.reason },
      });
      return;
    }
    db.prepare('DELETE FROM records WHERE batch_id = ?').run(batch.id);
    purgeVaultForBatch(db, batch.id, '授权处置：整批删除');
    db.prepare(
      `UPDATE batches SET status = 'deleted', disposed_action = 'delete', disposed_at = ?,
        disposed_by_job = ?, record_count = 0 WHERE id = ?`,
    ).run(nowIso(), job.id, batch.id);
    markTargetDone(db, job.id, batch.id, recs, recs, {
      action: 'delete',
      deletedRecords: recs,
    });
    audit(db, {
      action: 'disposition.batch.deleted',
      subjectId: batch.subject_id,
      jobId: job.id,
      batchId: batch.id,
      summary: `物理删除批次 ${batch.id} 的 ${recs} 条记录`,
      detail: { reason: target.reason, removedScopes },
    });
    return;
  }

  if (target.action === 'degrade') {
    const rows = db.prepare('SELECT * FROM records WHERE batch_id = ?').all(batch.id);
    let changed = 0;
    const upd = db.prepare(
      `UPDATE records SET payload = ?, state = 'degraded', state_reason = ?, state_job = ?, updated_at = ?
       WHERE id = ?`,
    );
    for (const row of rows) {
      const payload = parseJson(row.payload, {});
      let touched = false;
      for (const f of removedFields) {
        if (f in payload) {
          delete payload[f];
          touched = true;
        }
      }
      if (!touched) continue;
      upd.run(
        JSON.stringify(payload),
        `授权收窄：${removedScopes.map(scopeLabel).join('、')} 字段已抹除`,
        job.id,
        nowIso(),
        row.id,
      );
      changed += 1;
    }
    const remaining = db
      .prepare('SELECT fields, scopes FROM batches WHERE id = ?')
      .get(batch.id);
    const keptFields = parseJson(remaining.fields, []).filter((f) => !removedFields.includes(f));
    const keptScopes = parseJson(remaining.scopes, []).filter((s) => !removedScopes.includes(s));
    db.prepare(
      `UPDATE batches SET status = 'degraded', fields = ?, scopes = ?,
        disposed_action = 'degrade', disposed_at = ?, disposed_by_job = ? WHERE id = ?`,
    ).run(JSON.stringify(keptFields), JSON.stringify(keptScopes), nowIso(), job.id, batch.id);
    markTargetDone(db, job.id, batch.id, rows.length, rows.length, {
      action: 'degrade',
      recordsChanged: changed,
      removedFields,
    });
    audit(db, {
      action: 'disposition.batch.degraded',
      subjectId: batch.subject_id,
      jobId: job.id,
      batchId: batch.id,
      summary: `降级批次 ${batch.id}：${changed}/${rows.length} 条记录抹除字段 ${removedFields.join(', ')}`,
      detail: { reason: target.reason, removedScopes, removedFields, keptFields },
    });
    return;
  }

  if (target.action === 'quarantine') {
    const rows = db.prepare('SELECT * FROM records WHERE batch_id = ?').all(batch.id);
    const vaultId = shortId('vlt');
    db.prepare(
      `INSERT INTO vault_batches (id, subject_id, batch_id, job_id, reason, legal_hold, entry_count, state, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'held',?,?)`,
    ).run(
      vaultId,
      batch.subject_id,
      batch.id,
      job.id,
      target.reason,
      subject.legal_hold ? 1 : 0,
      rows.length,
      nowIso(),
      nowIso(),
    );
    const ins = db.prepare(
      `INSERT INTO vault_entries (vault_id, record_id, batch_id, subject_id, payload, state, created_at, updated_at)
       VALUES (?,?,?,?,?,'held',?,?)`,
    );
    for (const row of rows) {
      ins.run(vaultId, row.id, batch.id, batch.subject_id, row.payload, nowIso(), nowIso());
    }
    db.prepare('DELETE FROM records WHERE batch_id = ?').run(batch.id);
    db.prepare(
      `UPDATE batches SET status = 'quarantined', disposed_action = 'quarantine',
        disposed_at = ?, disposed_by_job = ?, record_count = 0 WHERE id = ?`,
    ).run(nowIso(), job.id, batch.id);
    markTargetDone(db, job.id, batch.id, rows.length, rows.length, {
      action: 'quarantine',
      vaultId,
      entries: rows.length,
    });
    audit(db, {
      action: 'disposition.batch.quarantined',
      subjectId: batch.subject_id,
      jobId: job.id,
      batchId: batch.id,
      summary: `隔离批次 ${batch.id}：${rows.length} 条记录迁入隔离区 ${vaultId}`,
      detail: { reason: target.reason, removedScopes },
    });
  }
}

function markTargetDone(db, jobId, batchId, seen, done, detail) {
  db.prepare(
    `UPDATE job_targets SET status = 'done', records_seen = ?, records_done = ?,
       processed_at = ?, detail = ? WHERE job_id = ? AND batch_id = ?`,
  ).run(seen, done, nowIso(), JSON.stringify(detail), jobId, batchId);
}

function purgeVaultForBatch(db, batchId, reason) {
  const vaults = db.prepare('SELECT * FROM vault_batches WHERE batch_id = ?').all(batchId);
  for (const v of vaults) {
    if (v.legal_hold) continue;
    db.prepare(`DELETE FROM vault_entries WHERE vault_id = ?`).run(v.id);
    db.prepare(`UPDATE vault_batches SET state = 'purged', entry_count = 0, updated_at = ? WHERE id = ?`).run(
      nowIso(),
      v.id,
    );
    audit(db, {
      action: 'vault.purged',
      subjectId: v.subject_id,
      batchId,
      summary: `隔离区副本 ${v.id} 已清除：${reason}`,
      detail: {},
    });
  }
}

/**
 * 释放 / 清除隔离副本。
 *  - dispose='restore'：仅当隔离批次当前仍在授权范围内时，才把副本复制回 records 并恢复可查。
 *  - dispose='purge'：物理清除副本，不可恢复。
 * 法务保全中的副本两种操作都拒绝。
 */
export function releaseVault(db, vaultId, { dispose = 'restore', reason = '' } = {}) {
  return tx(db, () => {
    const v = db.prepare('SELECT * FROM vault_batches WHERE id = ?').get(vaultId);
    if (!v) throw new LedgerError('E_VAULT_NOT_FOUND', '隔离条目不存在', 404);
    if (v.legal_hold) throw new LedgerError('E_LEGAL_HOLD', '法务保全中，不能释放或清除', 409);
    if (v.state !== 'held') throw new LedgerError('E_VAULT_STATE', `副本当前为 ${v.state}，不能重复处理`, 409);
    if (!['restore', 'purge'].includes(dispose)) throw new LedgerError('E_VAULT_DISPOSE', '未知的处置方式');

    const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(v.batch_id);
    const now = nowIso();

    if (dispose === 'purge') {
      db.prepare('DELETE FROM vault_entries WHERE vault_id = ?').run(vaultId);
      db.prepare(`UPDATE vault_batches SET state = 'purged', entry_count = 0, updated_at = ? WHERE id = ?`).run(
        now,
        vaultId,
      );
      if (batch && batch.status === 'quarantined') {
        db.prepare(
          `UPDATE batches SET disposed_action = 'delete', disposed_at = ? WHERE id = ?`,
        ).run(now, batch.id);
      }
      audit(db, {
        action: 'vault.purged',
        subjectId: v.subject_id,
        batchId: v.batch_id,
        summary: `隔离副本 ${vaultId} 已清除（${reason || '人工确认清除'}）`,
        detail: { vaultId, entries: v.entry_count },
      });
      return { state: 'purged', restored: 0 };
    }

    // restore：必须先确认当前授权重新覆盖该批次的用途与全部范围，否则等于绕过收窄。
    const snapshot = snapshotView(effectiveSnapshot(db, v.subject_id));
    if (!snapshot || snapshot.status === 'revoked') {
      throw new LedgerError('E_CONSENT_REVOKED', '当前授权已撤回，副本不能恢复为可查询数据', 409);
    }
    if (!batch) throw new LedgerError('E_BATCH_NOT_FOUND', '原批次不存在，无法恢复', 409);
    if (!snapshot.purposes.includes(batch.purpose)) {
      throw new LedgerError('E_PURPOSE_NOT_GRANTED', '用途仍未授权，副本不能恢复', 409);
    }
    const missingScopes = parseJson(batch.scopes, []).filter((s) => !snapshot.scopes.includes(s));
    if (missingScopes.length) {
      throw new LedgerError(
        'E_SCOPE_NOT_GRANTED',
        `范围「${missingScopes.map(scopeLabel).join('、')}」仍未授权，副本不能恢复`,
        409,
        { missingScopes },
      );
    }
    const entries = db.prepare('SELECT * FROM vault_entries WHERE vault_id = ? ORDER BY id ASC').all(vaultId);
    const insert = db.prepare(
      `INSERT INTO records (batch_id, subject_id, payload, captured_at, state, state_reason, state_job, updated_at)
       VALUES (?,?,?,?, 'live', NULL, NULL, ?)`,
    );
    let restored = 0;
    for (const e of entries) {
      insert.run(batch.id, batch.subject_id, e.payload, now, now);
      restored += 1;
    }
    if (!restored) throw new LedgerError('E_VAULT_EMPTY', '副本中没有可恢复的记录', 409);

    db.prepare(`UPDATE vault_batches SET state = 'released', updated_at = ? WHERE id = ?`).run(now, vaultId);
    db.prepare(
      `UPDATE batches SET status = 'sealed', record_count = ?, disposed_action = 'release', disposed_at = ?
        WHERE id = ?`,
    ).run(restored, now, batch.id);
    audit(db, {
      action: 'vault.released',
      subjectId: v.subject_id,
      batchId: v.batch_id,
      summary: `隔离副本 ${vaultId} 恢复 ${restored} 条记录到可查询面（${reason || '授权范围内恢复'}）`,
      detail: { vaultId, restored, snapshotVersion: snapshot.version },
    });
    return { state: 'released', restored };
  });
}

export function pauseJob(db, jobId, reason = '人工暂停') {
  return tx(db, () => {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) throw new LedgerError('E_JOB_NOT_FOUND', '任务不存在', 404);
    if (!['pending', 'running'].includes(job.status)) {
      throw new LedgerError('E_JOB_STATE', `任务当前为 ${job.status}，无法暂停`, 409);
    }
    db.prepare(`UPDATE jobs SET status = 'paused', last_error = ?, updated_at = ? WHERE id = ?`).run(
      reason,
      nowIso(),
      jobId,
    );
    audit(db, {
      action: 'disposition.paused',
      subjectId: job.subject_id,
      jobId,
      summary: `人工暂停任务：${reason}`,
      detail: {},
    });
    return jobView(db, jobId);
  });
}

export function retryJob(db, jobId, opts = {}) {
  return tx(db, () => {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) throw new LedgerError('E_JOB_NOT_FOUND', '任务不存在', 404);
    if (job.status === 'completed') throw new LedgerError('E_JOB_STATE', '任务已完成', 409);
    // 失败目标重置为 pending，已完成的不重复处理。
    const reset = db
      .prepare(`UPDATE job_targets SET status = 'pending', detail = NULL WHERE job_id = ? AND status = 'failed'`)
      .run(jobId).changes;
    db.prepare(
      `UPDATE jobs SET status = 'pending', last_error = NULL, updated_at = ? WHERE id = ?`,
    ).run(nowIso(), jobId);
    audit(db, {
      action: 'disposition.retried',
      subjectId: job.subject_id,
      jobId,
      summary: `重试任务：重置 ${reset} 个失败目标`,
      detail: { resetTargets: reset },
    });
    return jobView(db, jobId);
  });
}

export function resumeJob(db, jobId, opts = {}) {
  return runJob(db, jobId, { ...opts, resume: true });
}

/* ------------------------------------------------------------------ */
/* 留存清理                                                             */
/* ------------------------------------------------------------------ */

export function sweepRetention(db, opts = {}) {
  const dryRun = !!opts.dryRun;
  const at = opts.now ? new Date(opts.now) : new Date();
  const sealed = db
    .prepare(`SELECT * FROM batches WHERE status IN ('sealed','degraded','quarantined')`)
    .all();
  const due = [];
  for (const b of sealed) {
    if (b.legal_hold) continue;
    const anchor = b.sealed_at ?? b.started_at;
    const expiresAt = addDays(anchor, b.retention_days);
    if (new Date(expiresAt) <= at) due.push({ batch: b, expiresAt });
  }
  if (dryRun) return { dryRun: true, due: due.length, batches: due.map((d) => d.batch.id) };

  let removed = 0;
  for (const { batch } of due) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM records WHERE batch_id = ?').get(batch.id).n;
    db.prepare('DELETE FROM records WHERE batch_id = ?').run(batch.id);
    purgeVaultForBatch(db, batch.id, '保留期到期');
    db.prepare(
      `UPDATE batches SET status = 'deleted', disposed_action = 'retention', disposed_at = ?,
        record_count = 0 WHERE id = ?`,
    ).run(nowIso(), batch.id);
    removed += n;
    audit(db, {
      action: 'retention.swept',
      subjectId: batch.subject_id,
      batchId: batch.id,
      summary: `保留期到期清理：批次 ${batch.id} 删除 ${n} 条记录`,
      detail: { retentionDays: batch.retention_days, expiresAt: addDays(batch.sealed_at ?? batch.started_at, batch.retention_days) },
    });
  }
  return { dryRun: false, due: due.length, removedRecords: removed };
}

/* ------------------------------------------------------------------ */
/* 查询面                                                               */
/* ------------------------------------------------------------------ */

/**
 * 查询层只读在库记录。删除是物理删除、降级是字段抹除、隔离是迁出，
 * 三者都不是查询层过滤——这里的 WHERE 只是兜底。
 * 降级记录的剩余字段仍在授权范围内，必须继续可查，所以 state 包含 degraded。
 */
export function queryRecords(db, { subjectId, purpose, scope } = {}) {
  const where = [`r.state IN ('live','degraded')`, `b.status IN ('collecting','sealed','degraded')`];
  const args = [];
  if (subjectId) {
    where.push('r.subject_id = ?');
    args.push(subjectId);
  }
  if (purpose) {
    where.push('b.purpose = ?');
    args.push(purpose);
  }
  const rows = db
    .prepare(
      `SELECT r.id, r.subject_id, r.payload, r.captured_at, b.id AS batch_id, b.purpose,
              b.scopes, b.status AS batch_status
         FROM records r JOIN batches b ON b.id = r.batch_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.id ASC`,
    )
    .all(...args);
  return rows
    .filter((r) => !scope || parseJson(r.scopes, []).includes(scope))
    .map((r) => ({
      recordId: r.id,
      batchId: r.batch_id,
      subjectId: r.subject_id,
      purpose: r.purpose,
      batchStatus: r.batch_status,
      capturedAt: r.captured_at,
      payload: parseJson(r.payload, {}),
    }));
}

export function audit(db, { action, subjectId = null, jobId = null, batchId = null, snapshotId = null, summary, detail = {} }) {
  db.prepare(
    `INSERT INTO audit_log (at, actor, actor_role, action, subject_id, job_id, batch_id, snapshot_id, summary, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(nowIso(), ACTOR.id, ACTOR.role, action, subjectId, jobId, batchId, snapshotId, summary, JSON.stringify(detail));
}

/**
 * 通知入队。dedupe_key 唯一约束保证同一语义的通知只入队一次。
 * status='suppressed' 用于"已识别但刻意不下发"的记录（如重复通知）。
 */
function queueSubjectNotice(db, { subjectId, snapshotId, jobId = null, template, dedupeKey, status = 'queued' }) {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO notices (id, subject_id, job_id, snapshot_id, channel, template, dedupe_key, status, attempts, created_at, sent_at)
       VALUES (?,?,?,?, 'in-app',?,?,?,0,?,NULL)`,
    )
    .run(shortId('ntc'), subjectId, jobId, snapshotId, template, dedupeKey, status, nowIso());
  return { created: res.changes > 0 };
}

/** 模拟通知发送：幂等。已 sent/suppressed 的记录不会再次下发。 */
export function flushNotices(db, opts = {}) {
  const limit = Number(opts.limit ?? 100);
  const rows = db
    .prepare(`SELECT * FROM notices WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`)
    .all(limit);
  const sent = [];
  for (const n of rows) {
    db.prepare(
      `UPDATE notices SET status = 'sent', attempts = attempts + 1, sent_at = ? WHERE id = ? AND status = 'queued'`,
    ).run(nowIso(), n.id);
    sent.push(n.id);
    audit(db, {
      action: 'notice.sent',
      subjectId: n.subject_id,
      jobId: n.job_id,
      snapshotId: n.snapshot_id,
      summary: `通知已下发（${n.template}）`,
      detail: { noticeId: n.id, dedupeKey: n.dedupe_key },
    });
  }
  return { sent: sent.length };
}
