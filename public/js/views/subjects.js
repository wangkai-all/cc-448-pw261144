import { get, purposeLabel, scopeLabel, scopeInfo } from '../api.js';
import { esc, fmtNum, pill, chip } from '../dom.js';

export default async function subjects({ root, navigate }) {
  const list = await get('/api/subjects');

  root.innerHTML = `
    <div class="page-head">
      <div class="lead">
        <h1>授权与主体</h1>
        <p>每名主体的授权以不可变快照序列记录。版本号递增、条款哈希随内容变化，历史版本永不覆盖——它决定了当时采集的批次该怎么处置。</p>
      </div>
      <div class="actions">
        <a class="btn primary" href="#/ingest">新建采集批次</a>
      </div>
    </div>

    <div class="toolbar">
      <div class="search">
        <span>${'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="9" r="5.4"/><path d="m13.4 13.4 3 3" stroke-linecap="round"/></svg>'}</span>
        <input class="input" id="q" placeholder="搜索主体或渠道" />
      </div>
      <div class="spacer"></div>
      <span class="xsmall muted">共 ${list.length} 名主体</span>
    </div>

    <div class="grid cols-2" id="list">
      ${list.map(card).join('')}
    </div>
  `;

  const bind = () => {
    root.querySelectorAll('[data-subject]').forEach((n) =>
      n.addEventListener('click', () => navigate(`subject/${n.dataset.subject}`)),
    );
  };
  bind();
  root.querySelector('#q').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    root.querySelector('#list').innerHTML = list
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.channel.toLowerCase().includes(q))
      .map(card)
      .join('');
    bind();
  });
}

function card(s) {
  const snap = s.snapshot;
  const revoked = snap?.status === 'revoked';
  const tone = revoked ? 'critical' : s.batchCounts.blocked > 0 ? 'serious' : 'good';
  return `<div class="card subject-card" data-subject="${esc(s.id)}">
    <div class="subject-top">
      <div class="subject-avatar">${esc(s.name.slice(0, 1))}</div>
      <div class="subject-meta">
        <strong>${esc(s.name)}</strong>
        <span>${esc(s.channel)} · ${esc(s.contactHint)}</span>
      </div>
      <div class="spacer"></div>
      ${revoked ? pill('授权已撤回', 'critical', { dot: true }) : pill(`快照 v${snap?.version}`, 'info')}
      ${s.legalHold ? pill('法务保全', 'serious') : ''}
    </div>
    <div class="terms-line">
      ${revoked ? '<span class="muted">无有效授权，后续采集一律阻断</span>' : `
        <div><span class="muted">用途　</span>${snap?.purposes.map((p) => chip(purposeLabel(p))).join(' ') || '—'}</div>
        <div style="margin-top:4px"><span class="muted">范围　</span>${snap?.scopes.map((sc) => chip(scopeLabel(sc), scopeInfo(sc)?.risk === 'high' ? 'scope-high' : '')).join(' ') || '—'}</div>
        <div style="margin-top:4px"><span class="muted">保留　</span>${snap?.retentionDays} 天</div>
      `}
    </div>
    <div class="subject-stats">
      <div><b>${fmtNum(s.liveRecords)}</b><span>在库记录</span></div>
      <div><b>${fmtNum(s.batchCounts.total)}</b><span>采集批次</span></div>
      <div><b>${fmtNum(s.batchCounts.blocked)}</b><span>阻断</span></div>
      <div><b>${fmtNum(s.batchCounts.deleted + s.batchCounts.quarantined + s.batchCounts.degraded)}</b><span>已处置</span></div>
      <div style="margin-left:auto;align-self:center">${pill(s.openJobs ? `${s.openJobs} 个任务进行中` : '无待办', s.openJobs ? 'warn' : 'plain')}</div>
    </div>
  </div>`;
}
