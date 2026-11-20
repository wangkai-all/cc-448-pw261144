import { get, post } from '../api.js';
import {
  esc,
  fmtNum,
  fmtDate,
  fmtRelative,
  pill,
  statusPill,
  actionTag,
  progressBar,
  pct,
  TRIGGER_META,
  STATUS_META,
  AUDIT_KIND,
} from '../dom.js';
import { toast } from '../ui.js';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '未完成' },
  { key: 'paused', label: '待恢复' },
  { key: 'completed', label: '已完成' },
];

export default async function jobs({ root, query, navigate }) {
  let all = await get('/api/jobs');
  let filter = query.status ?? 'all';

  const applyFilter = (j) => {
    if (filter === 'all') return true;
    if (filter === 'open') return ['pending', 'running', 'paused', 'failed'].includes(j.status);
    return j.status === filter;
  };

  const renderRows = () => {
    const list = all.filter(applyFilter);
    root.querySelector('#rows').innerHTML = list.length
      ? list.map(row).join('')
      : `<tr><td colspan="8"><div class="empty"><p>没有符合筛选条件的任务</p></div></td></tr>`;
    bindRows();
    root.querySelector('#stat-line').innerHTML = statLine(all);
  };

  const bindRows = () => {
    root.querySelectorAll('[data-job]').forEach((n) =>
      n.addEventListener('click', (e) => {
        if (e.target.closest('button,a')) return;
        navigate(`job/${n.dataset.job}`);
      }),
    );
    root.querySelectorAll('[data-act]').forEach((btn) =>
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const { act, id } = btn.dataset;
        btn.disabled = true;
        try {
          if (act === 'run' || act === 'resume') {
            const r = await post(`/api/jobs/${id}/${act}`, { chunkSize: 3 });
            const j = r.job;
            toast(
              j.status === 'completed'
                ? `任务完成：处置 ${j.processedBatches} 个批次 / ${j.processedRecords} 条记录`
                : `任务暂停：${j.lastError ?? '等待恢复'}`,
              j.status === 'completed' ? 'good' : 'critical',
            );
          } else if (act === 'pause') {
            await post(`/api/jobs/${id}/pause`);
            toast('任务已暂停，检查点已保存', 'good');
          } else if (act === 'retry') {
            await post(`/api/jobs/${id}/retry`);
            toast('已重置失败目标，可再次执行', 'good');
          }
          all = await get('/api/jobs');
          renderRows();
        } catch (err) {
          toast(`${err.message}`, 'critical');
        } finally {
          btn.disabled = false;
        }
      }),
    );
  };

  root.innerHTML = `
    <div class="page-head">
      <div class="lead">
        <h1>处置任务</h1>
        <p>授权变更与保留期调整生成的显式队列。每个任务持有一份受影响批次清单，逐批执行并写入检查点；中断后可从未处理批次继续，已完成批次不会重复处置。</p>
      </div>
      <div class="actions">
        <a class="btn" href="#/audit?action=disposition">处置审计</a>
        <button class="btn" id="refresh">刷新</button>
      </div>
    </div>
    <div class="toolbar">
      ${FILTERS.map((f) => `<button class="filter-pill ${filter === f.key ? 'on' : ''}" data-filter="${f.key}">${f.label}</button>`).join('')}
      <div class="spacer"></div>
      <span class="xsmall muted" id="stat-line"></span>
    </div>
    <div class="card"><div class="card-body tight"><div class="table-wrap">
      <table class="data">
        <thead><tr><th>主体 / 任务</th><th>触发</th><th>动作</th><th>受影响批次</th><th style="width:190px">批次进度</th><th style="width:190px">记录进度</th><th>状态</th><th style="width:1%"></th></tr></thead>
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
  root.querySelector('#refresh').addEventListener('click', async () => {
    all = await get('/api/jobs');
    renderRows();
  });
  renderRows();
  void pct;
}

function row(j) {
  const t = TRIGGER_META[j.trigger] ?? { label: j.trigger, tone: 'plain' };
  const isOpen = ['pending', 'running', 'paused', 'failed'].includes(j.status);
  const tone = j.status === 'completed' ? 'good' : j.status === 'paused' ? 'warn' : j.status === 'failed' ? 'critical' : '';
  return `<tr class="clickable" data-job="${esc(j.id)}">
    <td>
      <strong>${esc(j.subjectName)}</strong>
      <div class="row-sub mono">${esc(j.id)} · v${j.fromSnapshot?.version ?? '—'} → v${j.toSnapshot?.version ?? '—'}</div>
    </td>
    <td>${pill(t.label, t.tone, { dot: true })}<div class="row-sub">${fmtRelative(j.createdAt)}</div></td>
    <td>${actionTag(j.action)}</td>
    <td class="num">${j.totalBatches}</td>
    <td>
      <div class="progress-line">${progressBar(j.processedBatches, j.totalBatches, tone)}<span class="meta">${j.processedBatches}/${j.totalBatches}</span></div>
    </td>
    <td>
      <div class="progress-line">${progressBar(j.processedRecords, j.totalRecords, tone)}<span class="meta">${fmtNum(j.processedRecords)}/${fmtNum(j.totalRecords)}</span></div>
    </td>
    <td>${statusPill(j.status)}${j.lastError ? `<div class="row-sub truncate" style="max-width:180px" title="${esc(j.lastError)}">${esc(j.lastError)}</div>` : ''}</td>
    <td>
      <div class="row" style="gap:4px">
        ${
          j.status === 'paused' || (j.status === 'failed')
            ? `<button class="btn sm primary" data-act="resume" data-id="${esc(j.id)}">恢复</button>`
            : j.status === 'pending'
              ? `<button class="btn sm primary" data-act="run" data-id="${esc(j.id)}">执行</button>`
              : j.status === 'running'
                ? `<button class="btn sm" data-act="pause" data-id="${esc(j.id)}">暂停</button>`
                : ''
        }
        ${isOpen ? `<a class="btn sm ghost" href="#/job/${esc(j.id)}">详情</a>` : `<a class="btn sm ghost" href="#/job/${esc(j.id)}">详情</a>`}
      </div>
    </td>
  </tr>`;
}

function statLine(all) {
  const open = all.filter((j) => ['pending', 'running', 'paused', 'failed'].includes(j.status));
  const paused = all.filter((j) => j.status === 'paused').length;
  const batches = open.reduce((a, j) => a + (j.totalBatches - j.processedBatches), 0);
  const records = open.reduce((a, j) => a + (j.totalRecords - j.processedRecords), 0);
  return `${open.length} 个未完成任务${paused ? `（${paused} 个待恢复）` : ''} · 待处置 ${batches} 批 / ${fmtNum(records)} 条`;
}

void STATUS_META;
void fmtDate;
void AUDIT_KIND;
