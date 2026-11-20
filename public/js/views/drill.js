import { get, post, purposeLabel, scopeLabel } from '../api.js';
import { esc, fmtNum, pill } from '../dom.js';
import { toast } from '../ui.js';

export default async function drill({ root }) {
  let data = await get('/api/drill');
  const results = new Map();

  const render = () => {
    const state = data.state;
    root.innerHTML = `
      <div class="page-head">
        <div class="lead">
          <h1>验证中心</h1>
          <p>在独立的沙箱主体上重放三类关键路径，每次运行重建固定场景并逐步断言。断言直接检查数据库落库结果与审计流水，而不是页面显示。</p>
        </div>
        <div class="actions">
          <button class="btn" id="reset">重置沙箱</button>
        </div>
      </div>

      <div class="grid cols-3" style="margin-bottom:20px">
        ${data.scenarios
          .map((s) => {
            const r = results.get(s.key);
            return `<div class="card"><div class="card-body">
              <div class="row" style="margin-bottom:6px">
                <h2 style="font-size:14px;flex:1">${esc(s.title)}</h2>
                ${r ? (r.ok ? pill('全部通过', 'good', { dot: true }) : pill(`${r.steps.filter((x) => !x.ok).length} 项失败`, 'critical', { dot: true })) : '<span class="pill plain">未运行</span>'}
              </div>
              <p class="small secondary" style="min-height:52px">${esc(s.desc)}</p>
              <button class="btn ${r?.ok ? '' : 'primary'} sm" data-run="${s.key}" style="margin-top:10px">${r ? '重新运行' : '运行验证'}</button>
            </div></div>`;
          })
          .join('')}
      </div>

      <div class="split">
        <div id="results">
          ${results.size ? '' : '<div class="card"><div class="card-body"><div class="empty"><div class="glyph">▷</div><p>运行任一场景后在此查看逐步断言结果</p></div></div></div>'}
          ${[...results.entries()].map(([key, r]) => resultBlock(data.scenarios.find((s) => s.key === key), r)).join('')}
        </div>
        <div>
          <div class="section-title"><h2>沙箱状态</h2><span class="hint">sub_drill · 最近一次运行后</span></div>
          <div class="card"><div class="card-body">
            ${
              state.subject
                ? `<dl class="kv">
                    <dt>当前快照</dt><dd>v${state.subject.snapshot?.version} · ${state.subject.snapshot?.status === 'revoked' ? '已撤回' : '有效'}</dd>
                    <dt>用途</dt><dd>${state.subject.snapshot?.purposes.map(purposeLabel).join('、') || '无'}</dd>
                    <dt>范围</dt><dd>${state.subject.snapshot?.scopes.map(scopeLabel).join('、') || '无'}</dd>
                    <dt>批次</dt><dd>${state.batches.length} 个</dd>
                    <dt>在库记录</dt><dd>${fmtNum(state.liveRecords)}</dd>
                    <dt>通知</dt><dd>${fmtNum(state.notices?.length ?? 0)} 条</dd>
                  </dl>`
                : '<p class="small muted">沙箱尚未初始化，运行任一场景即可创建</p>'
            }
          </div></div>
        </div>
      </div>
    `;
    root.querySelectorAll('[data-run]').forEach((b) =>
      b.addEventListener('click', async () => {
        const key = b.dataset.run;
        b.disabled = true;
        b.textContent = '运行中…';
        try {
          const r = await post(`/api/drill/${key}/run`, {});
          results.set(key, r);
          data = await get('/api/drill');
          render();
          toast(r.ok ? `${data.scenarios.find((s) => s.key === key).title}：全部断言通过` : '存在未通过的断言', r.ok ? 'good' : 'critical');
        } catch (err) {
          toast(err.message, 'critical');
          b.disabled = false;
        }
      }),
    );
    root.querySelector('#reset')?.addEventListener('click', async () => {
      await post('/api/drill/reset', {});
      data = await get('/api/drill');
      results.clear();
      render();
      toast('沙箱已重置', 'good');
    });
  };
  render();
}

function resultBlock(scenario, r) {
  const passed = r.steps.filter((s) => s.ok).length;
  return `<div class="card" style="margin-bottom:18px">
    <div class="card-head">
      <div>
        <h2>${esc(scenario.title)} <span class="muted" style="font-weight:400">· ${passed}/${r.steps.length} 通过</span></h2>
        <div class="sub">${esc(scenario.desc)}</div>
      </div>
      <div class="verdict ${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓ 全部通过' : '✕ 存在失败'}</div>
    </div>
    <div class="card-body">
      <div class="steps">
        ${r.steps
          .map(
            (s) => `<div class="step ${s.ok ? 'ok' : 'bad'}">
              <div class="mark">${s.ok ? '✓' : '✕'}</div>
              <div>
                <div class="t">${esc(s.title)}</div>
                <div class="d">${esc(s.detail)}</div>
                ${s.evidence ? `<pre class="evidence">${esc(JSON.stringify(s.evidence, null, 2))}</pre>` : ''}
              </div>
            </div>`,
          )
          .join('')}
      </div>
    </div>
  </div>`;
}
