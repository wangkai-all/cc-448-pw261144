import { get } from '../api.js';
import { esc, fmtFull, fmtRelative, pill, AUDIT_KIND } from '../dom.js';

const GROUPS = [
  { key: 'all', label: '全部', test: () => true },
  { key: 'consent', label: '授权变更', test: (a) => a.action.startsWith('consent') },
  { key: 'ingest', label: '采集与阻断', test: (a) => a.action.startsWith('ingest') || a.action.startsWith('batch') },
  { key: 'disposition', label: '处置执行', test: (a) => a.action.startsWith('disposition') || a.action.startsWith('retention') },
  { key: 'vault', label: '隔离与保全', test: (a) => a.action.startsWith('vault') },
  { key: 'notice', label: '通知', test: (a) => a.action.startsWith('notice') },
];

const ACTION_TONE = {
  'consent.snapshot.created': 'info',
  'consent.notice.duplicate': 'plain',
  'consent.widened': 'good',
  'ingest.blocked': 'critical',
  'batch.created': 'good',
  'batch.sealed': 'good',
  'batch.blocked': 'critical',
  'batch.flagged': 'warn',
  'disposition.planned': 'info',
  'disposition.started': 'info',
  'disposition.paused': 'serious',
  'disposition.completed': 'good',
  'disposition.deduped': 'plain',
  'disposition.retried': 'warn',
  'disposition.batch.deleted': 'critical',
  'disposition.batch.degraded': 'warn',
  'disposition.batch.quarantined': 'serious',
  'disposition.retention.applied': 'serious',
  'disposition.skipped_hold': 'serious',
  'retention.swept': 'plain',
  'vault.purged': 'critical',
  'notice.sent': 'plain',
};

export default async function audit({ root, query }) {
  const [all, subjects, jobs] = await Promise.all([get('/api/audit?limit=400'), get('/api/subjects'), get('/api/jobs')]);
  const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
  const jobMap = new Map(jobs.map((j) => [j.id, j]));
  let group = query.action ?? 'all';
  let subject = query.subject ?? 'all';
  let q = '';

  const render = () => {
    const g = GROUPS.find((x) => x.key === group) ?? GROUPS[0];
    const rows = all.filter((a) => {
      if (!g.test(a)) return false;
      if (subject !== 'all' && a.subjectId !== subject) return false;
      if (q) {
        const hay = `${a.summary} ${a.action} ${a.actor}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
    root.querySelector('#rows').innerHTML = rows.length
      ? rows
          .map(
            (a) => `<div class="audit-row" data-kind="${AUDIT_KIND(a.action)}">
              <div class="bar"></div>
              <div class="at" title="${fmtFull(a.at)}">${fmtRelative(a.at)}</div>
              <div class="what">
                <div>${esc(a.summary)}</div>
                <div class="row wrap" style="gap:6px;margin-top:5px">
                  <span class="code">${esc(a.action)}</span>
                  ${a.subjectId ? `<a class="xsmall" href="#/subject/${esc(a.subjectId)}">${esc(subjectName.get(a.subjectId) ?? a.subjectId)}</a>` : ''}
                  ${a.jobId ? `<a class="xsmall mono" href="#/job/${esc(a.jobId)}">${esc(a.jobId)}</a>` : ''}
                  ${a.batchId ? `<a class="xsmall mono" href="#/batches?focus=${esc(a.batchId)}">${esc(a.batchId)}</a>` : ''}
                  <span class="xsmall muted">${esc(a.actorRole)}</span>
                </div>
                ${
                  Object.keys(a.detail ?? {}).length
                    ? `<details style="margin-top:5px"><summary class="xsmall muted" style="cursor:pointer">明细</summary><pre class="evidence">${esc(JSON.stringify(a.detail, null, 2))}</pre></details>`
                    : ''
                }
              </div>
              <div>${{good:'✓',critical:'✕',warn:'!',serious:'!',info:'·',plain:''}[ACTION_TONE[a.action] ?? 'plain'] ? pill(ACTION_TONE[a.action] === 'plain' ? '记录' : {good:'成功',critical:'阻断/删除',warn:'需关注',serious:'敏感处置',info:'信息'}[ACTION_TONE[a.action]], ACTION_TONE[a.action] ?? 'plain') : ''}</div>
            </div>`,
          )
          .join('')
      : '<div class="empty"><p>没有匹配的审计记录</p></div>';
    root.querySelector('#count').textContent = `${rows.length} 条`;
  };

  root.innerHTML = `
    <div class="page-head">
      <div class="lead">
        <h1>审计记录</h1>
        <p>授权快照创建、采集阻断、处置计划与执行、隔离与保留期清理，全部追加写入、不可篡改。页面与接口读的是同一份审计流水。</p>
      </div>
      <div class="actions"><span class="xsmall muted" id="count"></span></div>
    </div>
    <div class="toolbar">
      ${GROUPS.map((g) => `<button class="filter-pill ${group === g.key ? 'on' : ''}" data-group="${g.key}">${g.label}</button>`).join('')}
      <div class="spacer"></div>
      <select class="select" id="subject" style="width:auto">
        <option value="all">全部主体</option>
        ${subjects.map((s) => `<option value="${esc(s.id)}" ${subject === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>
      <div class="search"><span><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="9" r="5.4"/><path d="m13.4 13.4 3 3" stroke-linecap="round"/></svg></span><input class="input" id="q" placeholder="搜索摘要 / 动作" /></div>
    </div>
    <div class="card"><div class="card-body"><div class="audit-list" id="rows"></div></div></div>
  `;

  root.querySelectorAll('[data-group]').forEach((b) =>
    b.addEventListener('click', () => {
      group = b.dataset.group;
      root.querySelectorAll('[data-group]').forEach((x) => x.classList.toggle('on', x === b));
      render();
    }),
  );
  root.querySelector('#subject').addEventListener('change', (e) => {
    subject = e.target.value;
    render();
  });
  root.querySelector('#q').addEventListener('input', (e) => {
    q = e.target.value;
    render();
  });
  render();
  void jobMap;
}
