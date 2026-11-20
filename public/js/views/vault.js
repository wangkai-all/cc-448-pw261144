import { get, post } from '../api.js';
import { esc, fmtNum, fmtDate, pill } from '../dom.js';
import { openModal, toast } from '../ui.js';

export default async function vault({ root }) {
  const [items, jobs] = await Promise.all([get('/api/vault'), get('/api/jobs')]);
  const totalHeld = items.filter((v) => v.state === 'held').reduce((a, v) => a + v.entryCount, 0);
  const jobMap = new Map(jobs.map((j) => [j.id, j]));

  const act = (v) => {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="note info" style="margin-bottom:14px">
        <span class="i">i</span>
        <div>恢复只在当前授权仍覆盖该批次用途与字段时可用；否则只能清除。两种操作都会写审计。</div>
      </div>
      <dl class="kv">
        <dt>隔离副本</dt><dd class="mono">${esc(v.id)}</dd>
        <dt>原始批次</dt><dd class="mono">${esc(v.batchId)}</dd>
        <dt>隔离记录</dt><dd>${fmtNum(v.entryCount)} 条</dd>
        <dt>隔离原因</dt><dd>${esc(v.reason)}</dd>
      </dl>
      <div class="row" style="margin-top:14px">
        <button class="btn sm" id="vault-purge" type="button">永久清除副本</button>
        <span class="xsmall muted">清除不可恢复；恢复会把仍授权的字段写回可查询面</span>
      </div>`;
    const modal = openModal({
      title: '处理隔离副本',
      desc: '恢复为可查询数据，或确认永久清除。',
      body,
      confirmText: '恢复为可查询',
      cancelText: '取消',
      onConfirm: async () => {
        try {
          const r = await post(`/api/vault/${v.id}/release`, { dispose: 'restore', reason: '人工复核后恢复' });
          toast(`已恢复 ${fmtNum(r.restored)} 条记录`, 'good');
          await reload();
        } catch (err) {
          toast(err.message, 'critical');
          return false;
        }
      },
    });
    body.querySelector('#vault-purge').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '清除中…';
      try {
        await post(`/api/vault/${v.id}/release`, { dispose: 'purge', reason: '人工确认清除' });
        modal.close();
        toast('隔离副本已清除', 'good');
        await reload();
      } catch (err) {
        toast(err.message, 'critical');
        btn.disabled = false;
        btn.textContent = '永久清除副本';
      }
    });
  };

  const reload = async () => {
    const [nextItems, nextJobs] = await Promise.all([get('/api/vault'), get('/api/jobs')]);
    items.splice(0, items.length, ...nextItems);
    jobMap.clear();
    for (const j of nextJobs) jobMap.set(j.id, j);
    render();
  };

  const render = () => {
    const held = items.filter((v) => v.state === 'held');
    root.innerHTML = `
    <div class="page-head">
      <div class="lead">
        <h1>隔离区</h1>
        <p>当授权收窄涉及敏感范围时，相关批次不会留在可查询面上：整批记录迁入隔离区保存副本，查询接口读不到。隔离数据受法务保全约束，释放或清除均需审计留痕。</p>
      </div>
    </div>
    <div class="kpi-strip" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <div class="stat"><div class="label">隔离副本</div><div class="value tnum">${held.length}</div><div class="foot">共 ${items.length} 个批次副本</div></div>
      <div class="stat"><div class="label">隔离记录</div><div class="value tnum">${fmtNum(held.reduce((a, v) => a + v.entryCount, 0))}</div><div class="foot">查询接口不可见</div></div>
      <div class="stat"><div class="label">法务保全</div><div class="value tnum">${items.filter((v) => v.legalHold).length}</div><div class="foot">保全期间不释放、不清理</div></div>
    </div>
    <div class="card"><div class="card-body tight"><div class="table-wrap">
      <table class="data">
        <thead><tr><th>隔离副本</th><th>主体</th><th>原批次</th><th class="num">记录</th><th>来源任务</th><th>原因</th><th>状态</th><th></th></tr></thead>
        <tbody>
          ${
            items.length
              ? items
                  .map((v) => {
                    const j = jobMap.get(v.jobId);
                    return `<tr>
                      <td><span class="batch-id">${esc(v.id)}</span><div class="row-sub">${fmtDate(v.createdAt)}</div></td>
                      <td><a href="#/subject/${esc(v.subjectId)}">${esc(j?.subjectName ?? v.subjectId)}</a></td>
                      <td><span class="batch-id">${esc(v.batchId)}</span></td>
                      <td class="num">${fmtNum(v.entryCount)}</td>
                      <td>${j ? `<a href="#/job/${esc(j.id)}">${esc(j.triggerLabel)}</a>` : '<span class="muted">—</span>'}</td>
                      <td><span class="small secondary">${esc(v.reason)}</span></td>
                      <td>${pill(v.state === 'held' ? '隔离中' : v.state === 'released' ? '已释放' : '已清除', v.state === 'held' ? 'serious' : 'plain', { dot: true })}${v.legalHold ? ' ' + pill('法务保全', 'critical') : ''}</td>
                      <td class="nowrap">${v.state === 'held' && !v.legalHold ? `<button class="btn ghost sm" data-vault="${esc(v.id)}">处理</button>` : v.legalHold ? '<span class="xsmall muted">保全中</span>' : '<span class="xsmall muted">已处理</span>'}</td>
                    </tr>`;
                  })
                  .join('')
              : '<tr><td colspan="8"><div class="empty"><div class="glyph">🔒</div><p>暂无隔离副本</p></div></td></tr>'
          }
        </tbody>
      </table>
    </div></div></div>

    <div class="section-title"><h2>隔离规则</h2></div>
    <div class="grid cols-3">
      <div class="card"><div class="card-body">
        <h3 style="font-size:13px;margin-bottom:6px">何时隔离</h3>
        <p class="small secondary">失权的范围包含高风险字段（联系方式、精确定位、语音记录），且批次仍有其他仍授权字段时，整批迁入隔离区，避免敏感字段残留在可查询面。</p>
      </div></div>
      <div class="card"><div class="card-body">
        <h3 style="font-size:13px;margin-bottom:6px">与删除的区别</h3>
        <p class="small secondary">删除是不可恢复的物理清除；隔离保留副本以便合规复核、争议举证或后续依法释放。两者都不再由查询接口返回。</p>
      </div></div>
      <div class="card"><div class="card-body">
        <h3 style="font-size:13px;margin-bottom:6px">与降级的区别</h3>
        <p class="small secondary">降级只抹除失权字段、保留仍授权字段，记录继续可查。仅当失权范围不是高风险字段时使用。</p>
      </div></div>
    </div>
  `;
    root.querySelectorAll('[data-vault]').forEach((b) => {
      b.addEventListener('click', () => act(items.find((v) => v.id === b.dataset.vault)));
    });
  };
  render();
}
