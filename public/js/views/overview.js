import { get, purposeLabel, scopeLabel } from '../api.js';
import {
  esc,
  fmtNum,
  fmtRelative,
  fmtDate,
  pill,
  statusPill,
  actionTag,
  TRIGGER_META,
  STATUS_META,
  ACTION_META,
  progressBar,
  pct,
} from '../dom.js';

const TONE_MAP = { critical: 'critical', serious: 'serious', warn: 'warn', info: 'info', good: 'good', plain: 'plain' };

function actionSegments(jobs) {
  const counts = { delete: 0, quarantine: 0, degrade: 0, none: 0 };
  for (const j of jobs) {
    if (j.action === 'mixed') {
      for (const t of j.targets) counts[t.action] = (counts[t.action] ?? 0) + 1;
    } else {
      counts[j.action] = (counts[j.action] ?? 0) + 1;
    }
  }
  return counts;
}

export default async function overview({ root, navigate }) {
  const data = await get('/api/overview');
  const { subjects, jobs, totals, recentAudit, jobStatusCounts } = data;
  const openJobs = jobs.filter((j) => ['pending', 'running', 'paused', 'failed'].includes(j.status));
  const paused = jobs.filter((j) => j.status === 'paused');
  const impactedBatches = subjects.reduce((a, s) => a + s.batchCounts.blocked + s.batchCounts.degraded + s.batchCounts.quarantined + s.batchCounts.deleted, 0);
  const blockingBatches = subjects.reduce((a, s) => a + s.batchCounts.blocked, 0);
  const seg = actionSegments(jobs);
  const segTotal = seg.delete + seg.quarantine + seg.degrade + seg.none;

  const pausedBanner = paused.length
    ? `<div class="banner" role="alert">
        <div class="b-ico">⏸</div>
        <div class="b-body">
          <strong>${paused.length} 个处置任务在检查点暂停，已入库数据尚未处置完毕</strong>
          <p>${paused.map((j) => `${esc(j.subjectName)} · ${esc(j.triggerLabel)} · 进度 ${j.processedBatches}/${j.totalBatches} 批`).join('；')}。恢复后从下一个批次继续，不会重复处理已完成批次。</p>
        </div>
        <div class="b-actions">
          ${paused.map((j) => `<button class="btn primary sm" data-resume="${esc(j.id)}">恢复 ${esc(j.subjectName)}</button>`).join('')}
          <a class="btn sm" href="#/jobs?status=paused">查看队列</a>
        </div>
      </div>`
    : '';

  root.innerHTML = `
    <div class="page-head">
      <div class="lead">
        <h1>授权快照与数据处置总览</h1>
        <p>每个采集批次绑定创建时刻的用途、范围与保留期限。授权收窄或撤回后，后续采集被阻断，已入库数据按影响范围进入删除、降级或隔离队列。</p>
      </div>
      <div class="actions">
        <button class="btn" id="refresh">${'刷新'}</button>
        <a class="btn" href="#/drill">验证中心</a>
        <a class="btn primary" href="#/ingest">新建采集批次</a>
      </div>
    </div>

    ${pausedBanner}

    <div class="kpi-strip">
      <div class="stat accent">
        <div class="label">受影响批次</div>
        <div class="value tnum">${fmtNum(impactedBatches)}<small>/ ${fmtNum(totals.batches)}</small></div>
        <div class="foot">${blockingBatches > 0 ? `${blockingBatches} 个批次因超授权被阻断` : '阻断批次：0'}</div>
      </div>
      <div class="stat">
        <div class="label">在库可查询记录</div>
        <div class="value tnum">${fmtNum(totals.liveRecords)}</div>
        <div class="foot">删除为物理清除，隔离已迁出查询面</div>
      </div>
      <div class="stat">
        <div class="label">未完成处置任务</div>
        <div class="value tnum">${fmtNum(openJobs.length)}</div>
        <div class="foot">${jobStatusCounts.paused ? `<span style="color:var(--serious-ink)">${jobStatusCounts.paused} 个待恢复</span> · ` : ''}${jobStatusCounts.pending ?? 0} 个待执行</div>
      </div>
      <div class="stat">
        <div class="label">隔离区留存</div>
        <div class="value tnum">${fmtNum(totals.heldEntries)}</div>
        <div class="foot">不可查询 · 待合规复核</div>
      </div>
    </div>

    <div class="split">
      <div>
        <div class="section-title"><h2>处置队列</h2><span class="hint">按触发来源与执行状态</span></div>
        <div class="card">
          <div class="card-body tight">
            <div class="table-wrap">
              <table class="data">
                <thead><tr><th>主体</th><th>触发</th><th>处置动作</th><th class="num">批次</th><th style="width:132px">进度</th><th>状态</th><th></th></tr></thead>
                <tbody>
                  ${
                    jobs.length
                      ? jobs
                          .slice(0, 8)
                          .map((j) => {
                            const t = TRIGGER_META[j.trigger] ?? { label: j.trigger, tone: 'plain' };
                            const p = pct(j.processedBatches, j.totalBatches);
                            return `<tr class="clickable" data-job="${esc(j.id)}">
                              <td><strong>${esc(j.subjectName)}</strong><div class="row-sub">目标快照 v${j.toSnapshot?.version ?? '—'}</div></td>
                              <td>${pill(t.label, t.tone, { dot: true })}</td>
                              <td>${actionTag(j.action)}</td>
                              <td class="num">${j.processedBatches}<span class="muted">/${j.totalBatches}</span></td>
                              <td>
                                <div class="progress-line">
                                  <span style="flex:1;min-width:60px">${progressBar(j.processedBatches, j.totalBatches, j.status === 'completed' ? 'good' : j.status === 'paused' ? 'warn' : '')}</span>
                                  <span class="meta">${p}%</span>
                                </div>
                              </td>
                              <td>${statusPill(j.status)}</td>
                              <td class="nowrap" style="text-align:right"><span class="muted small">详情 ›</span></td>
                            </tr>`;
                          })
                          .join('')
                      : `<tr><td colspan="7"><div class="empty"><p>暂无处置任务</p></div></td></tr>`
                  }
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="section-title"><h2>主体授权状态</h2><span class="hint">点开查看版本链与受影响批次</span></div>
        <div class="grid cols-2">
          ${subjects
            .map((s) => {
              const snap = s.snapshot;
              const revoked = snap?.status === 'revoked';
              const terms = revoked
                ? '授权已撤回'
                : `用途 ${snap?.purposes.map(purposeLabel).join('、') || '—'} · 保留 ${snap?.retentionDays ?? '—'} 天`;
              return `<div class="card subject-card" data-subject="${esc(s.id)}">
                <div class="subject-top">
                  <div class="subject-avatar">${esc(s.name.slice(0, 1))}</div>
                  <div class="subject-meta">
                    <strong>${esc(s.name)}</strong>
                    <span>${esc(s.channel)} · ${esc(s.contactHint)}</span>
                  </div>
                  <div class="spacer"></div>
                  ${revoked ? pill('已撤回', 'critical', { dot: true }) : pill(`v${snap?.version ?? '—'}`, 'info')}
                </div>
                <div class="terms-line">${esc(terms)}</div>
                <div class="subject-stats">
                  <div><b>${fmtNum(s.liveRecords)}</b><span>在库记录</span></div>
                  <div><b>${fmtNum(s.batchCounts.blocked)}</b><span>阻断批次</span></div>
                  <div><b>${fmtNum(s.batchCounts.deleted + s.batchCounts.quarantined + s.batchCounts.degraded)}</b><span>已处置</span></div>
                  <div><b>${fmtNum(s.openJobs)}</b><span>进行中任务</span></div>
                </div>
              </div>`;
            })
            .join('')}
        </div>
      </div>

      <div>
        <div class="section-title"><h2>处置动作分布</h2></div>
        <div class="card">
          <div class="card-body">
            <div class="segbar" role="img" aria-label="处置动作分布">
              ${['delete', 'quarantine', 'degrade', 'none']
                .map((k) => (seg[k] ? `<span class="s-${k}" style="flex:${seg[k]}" title="${ACTION_META[k].label} ${seg[k]}"></span>` : ''))
                .join('')}
            </div>
            <div class="legend">
              ${['delete', 'quarantine', 'degrade', 'none']
                .map((k) => `<span><i class="s-${k}" style="background:var(--${k === 'delete' ? 'critical' : k === 'quarantine' ? 'serious' : k === 'degrade' ? 'warning' : 'line-strong'})"></i>${ACTION_META[k].label} ${seg[k]}</span>`)
                .join('')}
            </div>
            <p class="small muted" style="margin-top:10px">按处置目标统计（混合任务拆分到批次）。删除为物理清除；隔离迁出查询面；降级仅抹除失权字段。</p>
          </div>
        </div>

        <div class="section-title"><h2>版本与保留期提醒</h2></div>
        <div class="card">
          <div class="card-body">
            ${
              subjects
                .filter((s) => s.snapshot && s.snapshot.status === 'active')
                .map((s) => {
                  const snap = s.snapshot;
                  return `<div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--line)">
                    <div style="flex:1;min-width:0">
                      <div class="small strong">${esc(s.name)} · v${snap.version}</div>
                      <div class="xsmall muted truncate" title="${esc(snap.reason)}">${esc(snap.reason)}</div>
                    </div>
                    <div style="text-align:right">
                      <span class="chip">保留 ${snap.retentionDays} 天</span>
                      <div class="xsmall muted" style="margin-top:3px">${fmtDate(snap.effectiveAt)}</div>
                    </div>
                  </div>`;
                })
                .join('') || '<p class="small muted">暂无有效授权</p>'
            }
          </div>
        </div>

        <div class="section-title"><h2>最近审计</h2><a class="btn ghost sm" href="#/audit">全部</a></div>
        <div class="card">
          <div class="card-body" style="padding-top:12px">
            <div class="audit-list">
              ${
                recentAudit
                  .slice(0, 6)
                  .map(
                    (a) => `<div class="audit-row" data-kind="${auditKind(a.action)}">
                      <div class="bar"></div>
                      <div class="at">${fmtRelative(a.at)}</div>
                      <div class="what">${esc(a.summary)}</div>
                      <div class="code">${esc(a.action.split('.').pop())}</div>
                    </div>`,
                  )
                  .join('') || '<p class="small muted">暂无审计记录</p>'
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  root.querySelectorAll('[data-subject]').forEach((n) =>
    n.addEventListener('click', () => navigate(`subject/${n.dataset.subject}`)),
  );
  root.querySelectorAll('[data-job]').forEach((n) =>
    n.addEventListener('click', () => navigate(`job/${n.dataset.job}`)),
  );
  root.querySelectorAll('[data-resume]').forEach((n) =>
    n.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = n;
      btn.disabled = true;
      btn.textContent = '恢复中…';
      const { post } = await import('../api.js');
      try {
        await post(`/api/jobs/${btn.dataset.resume}/resume`, { chunkSize: 3 });
        const { refreshAll } = await import('../app.js');
        await refreshAll();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '恢复失败';
      }
    }),
  );
  root.querySelector('#refresh')?.addEventListener('click', async () => {
    const { refreshAll } = await import('../app.js');
    await refreshAll();
  });

  void fmtNum;
  void esc;
  void STATUS_META;
  void TONE_MAP;
  void segTotal;
}

function auditKind(action) {
  if (action.includes('delete') || action.includes('revoked')) return 'delete';
  if (action.includes('blocked') || action.includes('flagged')) return 'block';
  if (action.startsWith('consent')) return 'consent';
  if (action.includes('completed')) return 'complete';
  return 'default';
}
