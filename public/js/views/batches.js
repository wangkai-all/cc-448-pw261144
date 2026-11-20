import { get, purposeLabel, scopeLabel, scopeInfo } from '../api.js';
import { esc, fmtNum, fmtDate, pill, chip, chipList, actionTag, BATCH_META, AUDIT_KIND } from '../dom.js';
import { openDrawer } from '../ui.js';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'sealed', label: '已封存' },
  { key: 'blocked', label: '已阻断' },
  { key: 'degraded', label: '已降级' },
  { key: 'quarantined', label: '已隔离' },
  { key: 'deleted', label: '已删除' },
];

export default async function batches({ root, query, navigate }) {
  const list = await get('/api/batches');
  let filter = query.status ?? 'all';
  let q = query.q ?? '';

  const openBatch = async (id) => {
    const detail = await get(`/api/batches/${encodeURIComponent(id)}`);
    const b = detail.batch;
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="detail-section">
        <h3>绑定关系</h3>
        <dl class="kv">
          <dt>主体</dt><dd><a href="#/subject/${esc(b.subjectId)}">${esc(b.subjectName)}</a></dd>
          <dt>采集来源</dt><dd>${esc(b.source)}</dd>
          <dt>授权快照</dt><dd>v${b.snapshotVersion} · <span class="hash">${esc(b.snapshotId)}</span></dd>
          <dt>条款哈希</dt><dd class="hash" style="word-break:break-all">${esc(b.termsHash)}</dd>
          <dt>用途</dt><dd>${esc(purposeLabel(b.purpose))}</dd>
          <dt>范围</dt><dd>${b.scopes.map((s) => chip(scopeLabel(s), scopeInfo(s)?.risk === 'high' ? 'scope-high' : '')).join(' ')}</dd>
          <dt>字段</dt><dd>${b.fields.map((f) => chip(f, 'mono')).join(' ')}</dd>
          <dt>保留期限</dt><dd>${b.retentionDays} 天${b.requestedRetention && b.requestedRetention !== b.retentionDays ? `（请求 ${b.requestedRetention} 天）` : ''}</dd>
          <dt>状态</dt><dd>${pill(BATCH_META[b.status]?.label ?? b.status, BATCH_META[b.status]?.tone ?? 'plain', { dot: true })}</dd>
          <dt>记录数</dt><dd>${fmtNum(b.recordCount)}</dd>
          <dt>采集时间</dt><dd>${fmtDate(b.startedAt)}${b.sealedAt ? ` · 封存 ${fmtDate(b.sealedAt)}` : ''}</dd>
          ${b.blockReason ? `<dt>阻断原因</dt><dd>${pill(b.blockCode ?? '', 'critical')} ${esc(b.blockReason)}</dd>` : ''}
          ${b.disposedAction ? `<dt>处置结果</dt><dd>${actionTag(b.disposedAction)} · ${fmtDate(b.disposedAt)} · 任务 <a href="#/job/${esc(b.disposedByJob)}">${esc(b.disposedByJob)}</a></dd>` : ''}
        </dl>
      </div>
      ${
        detail.vaults.length
          ? `<div class="detail-section"><h3>隔离区副本</h3><div class="stack">
              ${detail.vaults
                .map(
                  (v) => `<div class="row" style="gap:8px;font-size:12px;padding:8px;border:1px solid var(--line);border-radius:8px">
                    <span class="batch-id">${esc(v.id)}</span>
                    ${pill(v.state === 'purged' ? '已清除' : v.state === 'held' ? '隔离中' : '已释放', v.state === 'held' ? 'serious' : 'plain')}
                    <span class="muted">${fmtNum(v.entryCount)} 条</span>
                    ${v.legalHold ? pill('法务保全', 'critical') : ''}
                    <span class="secondary truncate" style="flex:1">${esc(v.reason)}</span>
                  </div>`,
                )
                .join('')}
            </div></div>`
          : ''
      }
      <div class="detail-section">
        <h3>记录样本（最多 20 条 · 仅显示仍在本表的行）</h3>
        ${
          detail.records.length
            ? `<div class="card" style="box-shadow:none"><div class="table-wrap"><table class="data compact">
                <thead><tr><th>#</th><th>字段内容</th><th>状态</th><th>采集于</th></tr></thead>
                <tbody>${detail.records
                  .map(
                    (r) => `<tr>
                      <td class="mono xsmall">${r.id}</td>
                      <td><div class="row wrap" style="gap:5px">${Object.entries(r.payload)
                        .map(([k, v]) => `<span class="chip mono">${esc(k)}=${esc(String(v)).slice(0, 22)}</span>`)
                        .join('')}</div></td>
                      <td>${pill(r.state === 'degraded' ? '已降级' : '可用', r.state === 'degraded' ? 'warn' : 'good')}</td>
                      <td class="xsmall muted">${fmtDate(r.capturedAt)}</td>
                    </tr>`,
                  )
                  .join('')}</tbody>
              </table></div></div>`
            : `<div class="note warn"><span class="i">∅</span><div>该批次在 records 表中已无任何行：${
                b.status === 'deleted'
                  ? '已被物理删除'
                  : b.status === 'quarantined'
                    ? '已迁出到隔离区'
                    : b.status === 'blocked'
                      ? '从未入库'
                      : '无数据'
              }。这是数据层的真实结果，不是查询层过滤。</div></div>`
        }
      </div>
      <div class="detail-section">
        <h3>批次审计</h3>
        <div class="audit-list">
          ${detail.audit
            .map(
              (a) => `<div class="audit-row" data-kind="${AUDIT_KIND(a.action)}">
                <div class="bar"></div>
                <div class="at">${fmtDate(a.at)}</div>
                <div class="what">${esc(a.summary)}</div>
                <div class="code">${esc(a.action.split('.').pop())}</div>
              </div>`,
            )
            .join('') || '<p class="small muted">暂无批次级审计</p>'}
        </div>
      </div>
    `;
    openDrawer({
      title: `批次 ${b.id}`,
      sub: `${b.subjectName} · ${b.source} · ${fmtDate(b.startedAt)}`,
      body,
    });
  };

  const renderRows = () => {
    const filtered = list.filter((b) => {
      if (filter !== 'all' && b.status !== filter) return false;
      if (q) {
        const hay = `${b.id} ${b.subjectName ?? ''} ${b.source}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
    root.querySelector('#rows').innerHTML = filtered.length
      ? filtered.map(row).join('')
      : `<tr><td colspan="7"><div class="empty"><p>没有符合条件的批次</p></div></td></tr>`;
    root.querySelectorAll('[data-batch]').forEach((n) => n.addEventListener('click', () => openBatch(n.dataset.batch)));
    root.querySelector('#count').textContent = `${filtered.length} / ${list.length}`;
  };

  root.innerHTML = `
    <div class="page-head">
      <div class="lead">
        <h1>采集批次</h1>
        <p>批次在创建时冻结授权快照，并只允许写入当时已授权的字段。封存与写入都会重新核对当前授权；超授权的批次被阻断而不入库。</p>
      </div>
      <div class="actions"><a class="btn primary" href="#/ingest">新建采集批次</a></div>
    </div>
    <div class="toolbar">
      ${FILTERS.map((f) => `<button class="filter-pill ${filter === f.key ? 'on' : ''}" data-filter="${f.key}">${f.label}</button>`).join('')}
      <div class="spacer"></div>
      <span class="xsmall muted" id="count"></span>
      <div class="search"><span><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="9" r="5.4"/><path d="m13.4 13.4 3 3" stroke-linecap="round"/></svg></span><input class="input" id="q" placeholder="批次号 / 主体" value="${esc(q)}" /></div>
    </div>
    <div class="card"><div class="card-body tight"><div class="table-wrap">
      <table class="data">
        <thead><tr><th>批次 / 来源</th><th>主体</th><th>绑定快照</th><th>用途 · 范围</th><th class="num">记录</th><th>状态</th><th>处置</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div></div></div>
  `;

  root.querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      root.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('on', x === b));
      renderRows();
    }),
  );
  root.querySelector('#q').addEventListener('input', (e) => {
    q = e.target.value;
    renderRows();
  });
  renderRows();
  if (query.focus) openBatch(query.focus);
  void chipList;
  void navigate;
}

function row(b) {
  const meta = BATCH_META[b.status] ?? { label: b.status, tone: 'plain' };
  return `<tr class="clickable" data-batch="${esc(b.id)}">
    <td><span class="batch-id">${esc(b.id)}</span><div class="row-sub">${esc(b.source)} · ${fmtDate(b.startedAt)}</div></td>
    <td><a href="#/subject/${esc(b.subjectId)}" onclick="event.stopPropagation()">${esc(b.subjectName ?? b.subjectId)}</a></td>
    <td><span class="chip mono">v${b.snapshotVersion}</span>${b.compliance === 'overbroad' ? ` ${pill('超出授权', 'critical')}` : ''}</td>
    <td><div class="small">${esc(purposeLabel(b.purpose))}</div><div class="row-sub">${b.scopes.map((s) => chip(scopeLabel(s), scopeInfo(s)?.risk === 'high' ? 'scope-high' : '')).join(' ')}</div></td>
    <td class="num">${fmtNum(b.recordCount)}</td>
    <td>${pill(meta.label, meta.tone, { dot: true })}${b.legalHold ? ' ' + pill('保全', 'serious') : ''}</td>
    <td>${b.disposedAction ? actionTag(b.disposedAction) : '<span class="muted small">—</span>'}</td>
  </tr>`;
}
