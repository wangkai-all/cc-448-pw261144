import { get, purposeLabel, scopeLabel, scopeInfo, meta } from '../api.js';
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
  BATCH_META,
  STATUS_META,
  TRIGGER_META,
  progressBar,
  pct,
} from '../dom.js';

export default async function subject({ root, params, navigate }) {
  const id = params[0];
  const s = await get(`/api/subjects/${encodeURIComponent(id)}`);
  await meta();
  const snapshots = s.snapshots;
  const current = s.snapshot;
  const active = snapshots.filter((x) => x.status === 'active');
  const revoked = current?.status === 'revoked';

  root.innerHTML = `
    <div class="page-head">
      <div class="lead">
        <div class="row" style="gap:12px;margin-bottom:8px">
          <div class="subject-avatar" style="width:44px;height:44px;font-size:17px">${esc(s.name.slice(0, 1))}</div>
          <div>
            <h1 style="margin-bottom:2px">${esc(s.name)}</h1>
            <p class="small">${esc(s.channel)} · ${esc(s.contactHint)} · 主体 ID ${esc(s.id)}</p>
          </div>
        </div>
        <p>当前授权 ${
          revoked
            ? pill('已撤回', 'critical', { dot: true })
            : `v${current?.version}（${fmtDate(current?.effectiveAt)} 生效）`
        }。用途 ${current?.purposes.map(purposeLabel).join('、') || '无'}；范围 ${current?.scopes.map(scopeLabel).join('、') || '无'}；保留 ${current?.retentionDays ?? 0} 天。</p>
      </div>
      <div class="actions">
        <button class="btn" id="new-consent">录入新授权通知</button>
        <a class="btn primary" href="#/ingest?subject=${esc(s.id)}">新建采集批次</a>
      </div>
    </div>

    ${s.legalHold ? `<div class="banner" style="border-color:color-mix(in srgb,var(--serious) 30%,var(--line));background:var(--serious-wash)"><div class="b-ico">⚖</div><div class="b-body"><strong style="color:var(--serious-ink)">该主体处于法务保全</strong><p>${esc(s.holdReason ?? '保全期间处置任务会跳过并升级人工审批')}</p></div></div>` : ''}

    <div class="kpi-strip">
      <div class="stat"><div class="label">授权版本</div><div class="value tnum">${snapshots.length}</div><div class="foot">${revoked ? '最新版本为撤回' : `当前 v${current?.version}`}</div></div>
      <div class="stat"><div class="label">在库可查询记录</div><div class="value tnum">${fmtNum(s.liveRecords)}</div><div class="foot">物理删除后不再计入</div></div>
      <div class="stat"><div class="label">采集批次</div><div class="value tnum">${fmtNum(s.batchCounts.total)}</div><div class="foot">${fmtNum(s.batchCounts.blocked)} 个阻断 · ${fmtNum(s.batchCounts.deleted)} 个已删除</div></div>
      <div class="stat"><div class="label">处置任务</div><div class="value tnum">${fmtNum(s.jobs.length)}</div><div class="foot">${fmtNum(s.openJobs)} 个未完成</div></div>
    </div>

    <div class="split">
      <div>
        <div class="section-title"><h2>采集批次与授权绑定</h2><span class="hint">每个批次冻结创建时的快照版本</span></div>
        <div class="card"><div class="card-body tight"><div class="table-wrap">
          <table class="data compact">
            <thead><tr><th>批次</th><th>绑定快照</th><th>用途 / 范围</th><th class="num">记录</th><th>状态</th><th>处置</th></tr></thead>
            <tbody>
              ${
                s.batches.length
                  ? s.batches.map(batchRow).join('')
                  : '<tr><td colspan="6"><div class="empty"><p>暂无采集批次</p></div></td></tr>'
              }
            </tbody>
          </table>
        </div></div></div>

        <div class="section-title"><h2>受影响批次与处置进度</h2></div>
        ${
          s.jobs.length
            ? s.jobs
                .map(
                  (j) => `<div class="card" style="margin-top:12px">
                    <div class="card-head">
                      <div>
                        <h2>${esc(TRIGGER_META[j.trigger]?.label ?? j.trigger)} · ${actionTag(j.action)} ${statusPill(j.status)}</h2>
                        <div class="sub">任务 ${esc(j.id)} · 依据快照 v${j.fromSnapshot?.version ?? '—'} → v${j.toSnapshot?.version ?? '—'} · ${statusPill(j.status)}</div>
                      </div>
                      <a class="btn sm" href="#/job/${esc(j.id)}">查看任务</a>
                    </div>
                    <div class="card-body">
                      <div class="progress-line" style="margin-bottom:12px">
                        ${progressBar(j.processedBatches, j.totalBatches, j.status === 'completed' ? 'good' : j.status === 'paused' ? 'warn' : '')}
                        <span class="meta">${j.processedBatches}/${j.totalBatches} 批 · ${fmtNum(j.processedRecords)}/${fmtNum(j.totalRecords)} 条</span>
                      </div>
                      <div class="stack">
                        ${
                          j.targets
                            .map(
                              (t) => `<div class="row" style="gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px">
                                <span class="batch-id">${esc(t.batchId)}</span>
                                ${actionTag(t.action)}
                                ${statusPill(t.status === 'done' ? 'completed' : t.status === 'pending' ? 'pending' : t.status, { completed: { label: '已处置', tone: 'good' }, pending: { label: '待处置', tone: 'warn' }, skipped: { label: '已跳过', tone: 'plain' }, failed: { label: '失败', tone: 'critical' } })}
                                <span class="small secondary truncate" style="flex:1" title="${esc(t.reason)}">${esc(t.reason)}</span>
                                <span class="xsmall muted nowrap">${fmtNum(t.recordsDone)}/${fmtNum(t.recordsSeen || t.recordCount)} 条</span>
                              </div>`,
                            )
                            .join('')
                        }
                      </div>
                    </div>
                  </div>`,
                )
                .join('')
            : `<div class="card"><div class="card-body"><div class="empty"><div class="glyph">✓</div><p>该主体尚无处置任务。授权收窄或撤回后会在这里生成影响清单。</p></div></div></div>`
        }
      </div>

      <div>
        <div class="section-title"><h2>授权版本链</h2><span class="hint">不可变 · 可追溯</span></div>
        <div class="card"><div class="card-body">
          <div class="timeline">
            ${snapshots
              .map((sn, i) => {
                const isCurrent = i === 0;
                const cls = sn.status === 'revoked' ? 'revoked' : isCurrent ? 'current' : '';
                return `<div class="tl-item ${cls}">
                  <div class="tl-node">${sn.version}</div>
                  <div class="tl-body">
                    <div class="tl-head">
                      <strong>v${sn.version}</strong>
                      ${isCurrent ? pill('当前生效', sn.status === 'revoked' ? 'critical' : 'good', { dot: true }) : pill('历史版本', 'plain')}
                      ${sn.status === 'revoked' ? pill('撤回', 'critical') : ''}
                    </div>
                    <div class="terms">${esc(sn.summary)}</div>
                    <div class="why">${esc(sn.reason)} · ${fmtFull(sn.effectiveAt)}</div>
                    <div class="hash" title="条款哈希：用途+范围+保留期+状态的规范化哈希">terms ${esc(sn.termsHash.slice(0, 16))}…</div>
                  </div>
                </div>`;
              })
              .join('') || '<p class="small muted">暂无快照</p>'}
          </div>
        </div></div>

        <div class="section-title"><h2>版本间差异</h2></div>
        <div class="card"><div class="card-body">
          ${
            snapshots.length > 1
              ? diffList(snapshots)
              : '<p class="small muted">只有一个版本，暂无差异</p>'
          }
        </div></div>
      </div>
    </div>
  `;

  root.querySelectorAll('[data-batch]').forEach((n) =>
    n.addEventListener('click', (e) => {
      if (e.target.closest('a,button')) return;
      navigate(`batches?focus=${n.dataset.batch}`);
    }),
  );
  root.querySelector('#new-consent').addEventListener('click', async () => {
    const { openConsentModal } = await import('../components/consentModal.js');
    openConsentModal({
      subject: s,
      onDone: async () => {
        const { refreshAll } = await import('../app.js');
        await refreshAll();
      },
    });
  });
  void active;
  void BATCH_META;
  void STATUS_META;
  void pct;
}

function batchRow(b) {
  const meta = BATCH_META[b.status] ?? { label: b.status, tone: 'plain' };
  return `<tr class="clickable" data-batch="${esc(b.id)}">
    <td>
      <span class="batch-id">${esc(b.id)}</span>
      <div class="row-sub">${esc(b.source)} · 采集于 ${fmtDate(b.startedAt)}</div>
    </td>
    <td>
      <span class="chip mono">v${b.snapshotVersion}</span>
      ${b.compliance === 'overbroad' ? pill('超出授权', 'critical') : ''}
      ${b.compliance === 'revoked' ? pill('撤回后尝试', 'critical') : ''}
    </td>
    <td>
      <div class="small">${esc(purposeLabel(b.purpose))}</div>
      <div class="row-sub">${b.scopes.map((sc) => chip(scopeLabel(sc), scopeInfo(sc)?.risk === 'high' ? 'scope-high' : '')).join(' ')}</div>
    </td>
    <td class="num">${fmtNum(b.recordCount)}</td>
    <td>${pill(meta.label, meta.tone, { dot: true })}${b.blockReason ? `<div class="row-sub" title="${esc(b.blockReason)}">${esc(b.blockCode)}</div>` : ''}</td>
    <td>${b.disposedAction ? actionTag(b.disposedAction) : '<span class="muted small">—</span>'}</td>
  </tr>`;
}

function diffList(snapshots) {
  return snapshots
    .slice(0, -1)
    .map((sn, i) => {
      const prev = snapshots[i + 1];
      const removedP = prev.purposes.filter((p) => !sn.purposes.includes(p));
      const removedS = prev.scopes.filter((x) => !sn.scopes.includes(x));
      const addedP = sn.purposes.filter((p) => !prev.purposes.includes(p));
      const addedS = sn.scopes.filter((x) => !prev.scopes.includes(x));
      const retention = sn.retentionDays !== prev.retentionDays;
      const parts = [];
      if (sn.status === 'revoked') parts.push(pill('整体撤回', 'critical'));
      removedP.forEach((p) => parts.push(pill(`撤掉用途：${purposeLabel(p)}`, 'critical')));
      removedS.forEach((x) => parts.push(pill(`撤掉范围：${scopeLabel(x)}`, 'serious')));
      addedP.forEach((p) => parts.push(pill(`新增用途：${purposeLabel(p)}`, 'good')));
      addedS.forEach((x) => parts.push(pill(`新增范围：${scopeLabel(x)}`, 'good')));
      if (retention) parts.push(pill(`保留 ${prev.retentionDays} → ${sn.retentionDays} 天`, sn.retentionDays < prev.retentionDays ? 'warn' : 'good'));
      if (!parts.length) parts.push(pill('条款无实质变化', 'plain'));
      return `<div style="padding:9px 0;border-bottom:1px solid var(--line)">
        <div class="small strong" style="margin-bottom:6px">v${prev.version} → v${sn.version}</div>
        <div class="row wrap" style="gap:6px">${parts.join('')}</div>
        <div class="xsmall muted" style="margin-top:5px">${esc(sn.reason)}</div>
      </div>`;
    })
    .join('');
}
