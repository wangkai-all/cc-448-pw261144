import { get, post, purposeLabel, scopeLabel } from '../api.js';
import {
  esc,
  fmtNum,
  fmtDate,
  fmtFull,
  fmtRelative,
  pill,
  chip,
  statusPill,
  actionTag,
  progressBar,
  pct,
  TRIGGER_META,
  AUDIT_KIND,
} from '../dom.js';
import { toast, openModal } from '../ui.js';

export default async function job({ root, params, navigate }) {
  const job = await get(`/api/jobs/${encodeURIComponent(params[0])}`);
  const tone = job.status === 'completed' ? 'good' : job.status === 'paused' ? 'warn' : job.status === 'failed' ? 'critical' : '';
  const t = TRIGGER_META[job.trigger] ?? { label: job.trigger, tone: 'plain' };

  root.innerHTML = `
    <div class="page-head">
      <div class="lead">
        <div class="row" style="gap:10px;margin-bottom:6px">
          <h1 style="margin:0">处置任务</h1>
          ${statusPill(job.status)}
          ${actionTag(job.action)}
        </div>
        <p><a href="#/subject/${esc(job.subjectId)}">${esc(job.subjectName)}</a> · ${pill(t.label, t.tone, { dot: true })} · 依据授权 v${job.fromSnapshot?.version ?? '—'} → v${job.toSnapshot?.version ?? '—'}（快照 <span class="hash">${esc(job.toSnapshot?.id ?? '')}</span>）</p>
      </div>
      <div class="actions" id="ops"></div>
    </div>

    ${
      job.status === 'paused'
        ? `<div class="banner" style="border-color:color-mix(in srgb,var(--serious) 32%,var(--line));background:var(--serious-wash)">
            <div class="b-ico">⏸</div>
            <div class="b-body">
              <strong style="color:var(--serious-ink)">任务在检查点暂停</strong>
              <p>${esc(job.lastError ?? '等待恢复')}。已完成 ${job.processedBatches}/${job.totalBatches} 批，恢复将从下一个未处理批次继续。</p>
            </div>
            <div class="b-actions"><button class="btn primary sm" data-act="resume">恢复执行</button></div>
          </div>`
        : ''
    }
    ${
      job.lastError && job.status === 'failed'
        ? `<div class="note critical" style="margin-bottom:16px"><span class="i">!</span><div>${esc(job.lastError)}</div></div>`
        : ''
    }

    <div class="kpi-strip">
      <div class="stat ${tone === 'good' ? '' : 'accent'}">
        <div class="label">批次进度</div>
        <div class="value tnum">${job.processedBatches}<small>/ ${job.totalBatches}</small></div>
        <div class="foot">${progressBar(job.processedBatches, job.totalBatches, tone)}</div>
      </div>
      <div class="stat">
        <div class="label">记录进度</div>
        <div class="value tnum">${fmtNum(job.processedRecords)}<small>/ ${fmtNum(job.totalRecords)}</small></div>
        <div class="foot">${progressBar(job.processedRecords, job.totalRecords, tone)}</div>
      </div>
      <div class="stat">
        <div class="label">执行尝试</div>
        <div class="value tnum">${job.attempts}</div>
        <div class="foot">含中断后恢复的次数</div>
      </div>
      <div class="stat">
        <div class="label">创建于</div>
        <div class="value" style="font-size:17px;margin-top:9px">${fmtRelative(job.createdAt)}</div>
        <div class="foot">${job.completedAt ? `完成于 ${fmtDate(job.completedAt)}` : '尚未完成'}</div>
      </div>
    </div>

    <div class="split">
      <div>
        <div class="section-title"><h2>受影响批次清单</h2><span class="hint">持久化队列 · 按序执行</span></div>
        <div class="card"><div class="card-body tight"><div class="table-wrap">
          <table class="data compact">
            <thead><tr><th style="width:34px">#</th><th>批次</th><th>动作</th><th>原因</th><th class="num">记录</th><th>状态</th></tr></thead>
            <tbody>
              ${job.targets
                .map(
                  (x) => `<tr class="clickable" data-batch="${esc(x.batchId)}">
                    <td class="muted xsmall">${x.ord + 1}</td>
                    <td><span class="batch-id">${esc(x.batchId)}</span><div class="row-sub">${esc(purposeLabel(x.purpose))} · ${esc(scopeLabelList(x))}</div></td>
                    <td>${actionTag(x.action)}</td>
                    <td><span class="small secondary">${esc(x.reason)}</span>${
                      x.removedFields?.length ? `<div class="row-sub">抹除字段：${x.removedFields.map((f) => chip(f, 'mono')).join(' ')}</div>` : ''
                    }</td>
                    <td class="num">${fmtNum(x.recordsDone)}<span class="muted">/${fmtNum(x.recordsSeen || x.recordCount)}</span></td>
                    <td>${targetStatus(x)}${x.legalHold ? '<div class="row-sub">法务保全</div>' : ''}</td>
                  </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div></div></div>

        <div class="section-title"><h2>执行审计</h2><span class="hint">每次开始 / 暂停 / 恢复 / 完成都留痕</span></div>
        <div class="card"><div class="card-body">
          <div class="audit-list">
            ${job.audit
              .map(
                (a) => `<div class="audit-row" data-kind="${AUDIT_KIND(a.action)}">
                  <div class="bar"></div>
                  <div class="at" title="${fmtFull(a.at)}">${fmtRelative(a.at)}</div>
                  <div class="what">${esc(a.summary)}</div>
                  <div class="code">${esc(a.action.split('.').pop())}</div>
                </div>`,
              )
              .join('') || '<p class="small muted">暂无审计</p>'}
          </div>
        </div></div>
      </div>

      <div>
        <div class="section-title"><h2>触发依据</h2></div>
        <div class="card"><div class="card-body">
          <div class="stack">
            <div>
              <div class="xsmall muted">来源快照</div>
              <div class="small">${job.fromSnapshot ? `v${job.fromSnapshot.version} · ${esc(job.fromSnapshot.summary)}` : '无（首次授权）'}</div>
            </div>
            <div style="border-top:1px solid var(--line);padding-top:10px">
              <div class="xsmall muted">目标快照</div>
              <div class="small strong">v${job.toSnapshot?.version} · ${esc(job.toSnapshot?.summary)}</div>
              <div class="xsmall muted" style="margin-top:3px">${esc(job.toSnapshot?.reason)}</div>
            </div>
            <div style="border-top:1px solid var(--line);padding-top:10px">
              <div class="xsmall muted">幂等键</div>
              <div class="hash" style="word-break:break-all">${esc(job.dedupeKey)}</div>
            </div>
            ${job.checkpoint ? `<div style="border-top:1px solid var(--line);padding-top:10px"><div class="xsmall muted">最近检查点</div><div class="hash">${esc(JSON.stringify(job.checkpoint))}</div></div>` : ''}
          </div>
        </div></div>

        <div class="section-title"><h2>差异摘要</h2></div>
        <div class="card"><div class="card-body">
          <div class="row wrap" style="gap:6px">
            ${
              [
                job.diff.removedPurposes.map((p) => pill(`撤掉用途：${purposeLabel(p)}`, 'critical')),
                job.diff.removedScopes.map((s) => pill(`撤掉范围：${scopeLabel(s)}`, 'serious')),
                job.diff.revoked ? [pill('整体撤回', 'critical')] : [],
                job.diff.retentionShrunk ? [pill(`保留 ${job.diff.prevRetention} → ${job.diff.nextRetention} 天`, 'warn')] : [],
              ]
                .flat()
                .join('') || pill('无差异', 'plain')
            }
          </div>
          <p class="xsmall muted" style="margin-top:10px">处置完成后，已入库数据的真实状态见批次详情：删除为物理清除、隔离为迁出、降级为字段抹除。</p>
        </div></div>

        <div class="section-title"><h2>任务信息</h2></div>
        <div class="card"><div class="card-body">
          <dl class="kv">
            <dt>任务 ID</dt><dd class="mono">${esc(job.id)}</dd>
            <dt>状态</dt><dd>${statusPill(job.status)}</dd>
            <dt>创建时间</dt><dd>${fmtFull(job.createdAt)}</dd>
            <dt>最后更新</dt><dd>${fmtFull(job.updatedAt)}</dd>
            <dt>开始时间</dt><dd>${fmtFull(job.startedAt)}</dd>
            <dt>完成时间</dt><dd>${fmtFull(job.completedAt)}</dd>
          </dl>
        </div></div>
      </div>
    </div>
  `;

  const reload = async () => {
    const { refreshAll } = await import('../app.js');
    await refreshAll();
  };

  const ops = root.querySelector('#ops');
  const canRun = ['pending', 'paused', 'failed'].includes(job.status);
  ops.innerHTML = `
    ${canRun ? `<button class="btn primary" data-act="${job.status === 'pending' ? 'run' : 'resume'}">${job.status === 'pending' ? '执行任务' : '恢复执行'}</button>` : ''}
    ${job.status === 'running' ? '<button class="btn" data-act="pause">暂停</button>' : ''}
    ${job.status === 'failed' ? '<button class="btn" data-act="retry">重置失败目标</button>' : ''}
    <a class="btn ghost" href="#/jobs">返回队列</a>
  `;

  root.querySelectorAll('[data-act]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      btn.disabled = true;
      btn.textContent = '处理中…';
      try {
        if (act === 'pause') {
          await post(`/api/jobs/${job.id}/pause`);
          toast('任务已暂停', 'good');
        } else if (act === 'retry') {
          await post(`/api/jobs/${job.id}/retry`);
          toast('失败目标已重置', 'good');
        } else {
          const r = await post(`/api/jobs/${job.id}/${act}`, { chunkSize: 2 });
          toast(
            r.job.status === 'completed'
              ? `任务完成：${r.job.processedBatches} 批 / ${r.job.processedRecords} 条`
              : `任务暂停：${r.job.lastError ?? '检查点已保存'}`,
            r.job.status === 'completed' ? 'good' : 'critical',
          );
        }
        await reload();
      } catch (err) {
        toast(err.message, 'critical');
        btn.disabled = false;
      }
    }),
  );

  root.querySelectorAll('[data-batch]').forEach((n) =>
    n.addEventListener('click', () => navigate(`batches?focus=${n.dataset.batch}`)),
  );

  void pct;
  void openModal;
}

function targetStatus(t) {
  if (t.status === 'done') return pill('已处置', 'good', { dot: true });
  if (t.status === 'pending') return pill('待处置', 'warn', { dot: true });
  if (t.status === 'failed') return pill('失败', 'critical', { dot: true });
  if (t.status === 'skipped') return pill('已跳过', 'plain', { dot: true });
  return pill(t.status, 'plain');
}

function scopeLabelList(t) {
  const scopes = t.removedScopes?.length ? t.removedScopes : null;
  return scopes ? scopes.map(scopeLabel).join('、') : '—';
}
