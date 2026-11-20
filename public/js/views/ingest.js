import { get, post, meta, purposeLabel, scopeLabel, fieldLabel } from '../api.js';
import { esc, fmtNum, pill } from '../dom.js';
import { toast } from '../ui.js';

/**
 * 采集接入模拟器：走与 SDK 相同的 createBatch / seal 路径，
 * 让阻断与超授权判定在页面上可复现。
 */
export default async function ingest({ root, query }) {
  const [m, subjects] = await Promise.all([meta(), get('/api/subjects')]);
  const subjectId = query.subject ?? subjects[0]?.id;
  const st = {
    subjectId,
    purpose: subjects.find((s) => s.id === subjectId)?.snapshot?.purposes?.[0] ?? 'analytics',
    scopes: new Set(['behavior']),
    recordCount: 12,
    result: null,
    busy: false,
  };

  const submit = async () => {
    const fields = [...st.scopes].flatMap((s) => m.scopes.find((x) => x.key === s)?.fields ?? []);
    if (!fields.length) {
      toast('请至少选择一个采集范围', 'critical');
      return;
    }
    const sample = {
      contact: '13800001234',
      device_id: 'dv-9f3a21c4',
      lat: 30.2741,
      lng: 120.1551,
      city: '杭州市西湖区',
      behavior: '浏览商品详情',
      voice: 'call_rec_042.wav',
    };
    const records = Array.from({ length: st.recordCount }, (_, i) => {
      const r = {};
      for (const f of fields) r[f] = f === 'behavior' ? `${sample.behavior} #${i + 1}` : sample[f];
      return r;
    });
    st.busy = true;
    render();
    try {
      const created = await post('/api/batches', {
        subjectId: st.subjectId,
        purpose: st.purpose,
        scopes: [...st.scopes],
        fields,
        source: '接入模拟器',
        records,
      });
      let sealed = null;
      if (created.status === 'collecting') {
        sealed = await post(`/api/batches/${created.batchId}/seal`, {});
        st.result = { ok: true, created, batch: sealed.batch };
        toast(`批次已建立并封存：${fmtNum(sealed.batch?.recordCount ?? 0)} 条记录入库`, 'good');
      } else {
        st.result = { ok: false, created, code: created.code, message: created.reason };
        toast('采集被阻断', 'critical');
      }
      const next = await get('/api/subjects');
      subjects.splice(0, subjects.length, ...next);
    } catch (err) {
      st.result = { ok: false, code: err.code, message: err.message, extra: err.extra };
      toast(err.message, 'critical');
    }
    st.busy = false;
    render();
  };

  function render() {
    const subject = subjects.find((s) => s.id === st.subjectId);
    const snap = subject?.snapshot;
    const active = snap?.status === 'active';
    const allowedPurposes = active ? snap.purposes : [];
    const allowedScopes = active ? snap.scopes : [];
    const fields = [...st.scopes].flatMap((s) => m.scopes.find((x) => x.key === s)?.fields ?? []);

    root.innerHTML = `
      <div class="page-head">
        <div class="lead">
          <h1>接入模拟器</h1>
          <p>模拟设备 SDK 提交一批采集数据。批次冻结当前授权快照；用途、范围或保留期超出授权时直接阻断，不会写入任何记录。</p>
        </div>
        <div class="actions"><a class="btn ghost" href="#/batches">查看批次</a></div>
      </div>

      <div class="split">
        <div class="card"><div class="card-body">
          <div class="field">
            <label for="subject">采集主体</label>
            <select class="select" id="subject">
              ${subjects
                .map(
                  (s) =>
                    `<option value="${esc(s.id)}" ${s.id === st.subjectId ? 'selected' : ''}>${esc(s.name)} · ${s.snapshot?.status === 'revoked' ? '已撤回' : `v${s.snapshot?.version}`}</option>`,
                )
                .join('')}
            </select>
          </div>

          <div class="note ${active ? 'info' : 'critical'}" style="margin-bottom:16px">
            <span class="i">${active ? 'i' : '✕'}</span>
            <div>${
              active
                ? `当前授权 v${snap.version}：用途 ${snap.purposes.map(purposeLabel).join('、')}；范围 ${snap.scopes.map(scopeLabel).join('、')}；保留 ${snap.retentionDays} 天。`
                : '该主体授权已撤回，任何新采集都会被阻断（原因码 CONSENT_REVOKED）。'
            }</div>
          </div>

          <div class="field">
            <label for="purpose">采集用途</label>
            <select class="select" id="purpose">
              ${m.purposes
                .map(
                  (p) =>
                    `<option value="${p.key}" ${p.key === st.purpose ? 'selected' : ''}>${esc(p.label)}${allowedPurposes.includes(p.key) ? '' : '（未授权）'}</option>`,
                )
                .join('')}
            </select>
          </div>

          <div class="field">
            <label>采集范围</label>
            <div class="check-grid">
              ${m.scopes
                .map(
                  (sc) => `<label class="check ${st.scopes.has(sc.key) ? 'on' : ''}" data-scope="${sc.key}">
                    <input type="checkbox" ${st.scopes.has(sc.key) ? 'checked' : ''} />
                    <span><span class="t">${esc(sc.label)}${allowedScopes.includes(sc.key) ? '' : ' · 未授权'}</span><span class="d">${esc(sc.desc)}</span></span>
                  </label>`,
                )
                .join('')}
            </div>
          </div>

          <div class="field">
            <label for="count">记录数</label>
            <input class="input" type="number" id="count" min="1" max="500" value="${st.recordCount}" style="width:120px" />
            <span class="help">将生成字段：${fields.length ? fields.map(fieldLabel).join('、') : '（先选范围）'}</span>
          </div>

          <div class="row">
            <button class="btn primary" id="submit" ${st.busy ? 'disabled' : ''}>${st.busy ? '提交中…' : '提交采集批次'}</button>
            <span class="xsmall muted">提交后自动封存并进入可查询状态</span>
          </div>
        </div></div>

        <div>
          <div class="section-title"><h2>当前选择</h2></div>
          <div class="card"><div class="card-body">
            <dl class="kv">
              <dt>绑定快照</dt><dd>${snap ? `v${snap.version} · ${snap.status === 'revoked' ? '已撤回' : '有效'}` : '无'}</dd>
              <dt>用途</dt><dd>${esc(purposeLabel(st.purpose))} ${allowedPurposes.includes(st.purpose) ? pill('已授权', 'good') : pill('未授权', 'critical')}</dd>
              <dt>范围</dt><dd class="row wrap" style="gap:5px">${
                [...st.scopes]
                  .map(
                    (s) =>
                      `<span class="chip ${allowedScopes.includes(s) ? '' : 'scope-high'}">${esc(scopeLabel(s))}</span>`,
                  )
                  .join(' ') || '—'
              }</dd>
              <dt>字段</dt><dd>${fields.map((f) => `<span class="chip mono">${esc(f)}</span>`).join(' ') || '—'}</dd>
              <dt>保留期</dt><dd>${snap?.retentionDays ?? 0} 天（跟随授权上限）</dd>
            </dl>
          </div></div>
          ${
            st.result
              ? `<div class="section-title"><h2>上次提交结果</h2></div>${resultCard(st.result)}`
              : ''
          }
        </div>
      </div>
    `;

    root.querySelector('#subject').addEventListener('change', (e) => {
      st.subjectId = e.target.value;
      const s = subjects.find((x) => x.id === st.subjectId);
      if (s?.snapshot?.status === 'active' && !s.snapshot.purposes.includes(st.purpose)) {
        st.purpose = s.snapshot.purposes[0] ?? st.purpose;
      }
      render();
    });
    root.querySelector('#purpose').addEventListener('change', (e) => {
      st.purpose = e.target.value;
      render();
    });
    root.querySelector('#count').addEventListener('change', (e) => {
      st.recordCount = Math.max(1, Math.min(500, Number(e.target.value) || 1));
    });
    root.querySelectorAll('[data-scope]').forEach((label) => {
      label.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) st.scopes.add(label.dataset.scope);
        else st.scopes.delete(label.dataset.scope);
        render();
      });
    });
    root.querySelector('#submit').addEventListener('click', submit);
  }

  render();
}

function resultCard(r) {
  if (r.ok) {
    return `<div class="card"><div class="card-body">
      <div class="note good" style="margin-bottom:12px"><span class="i">✓</span><div>批次已创建、绑定快照 v${r.batch?.snapshotVersion ?? '—'}，记录入库并可查询。</div></div>
      <dl class="kv">
        <dt>批次号</dt><dd class="mono">${esc(r.batch?.id ?? r.created.batchId)}</dd>
        <dt>状态</dt><dd>${esc(r.batch?.status ?? '')}</dd>
        <dt>入库记录</dt><dd>${fmtNum(r.batch?.recordCount ?? 0)}</dd>
        <dt>保留期</dt><dd>${r.batch?.retentionDays ?? '—'} 天</dd>
      </dl>
      <a class="btn sm" style="margin-top:12px" href="#/batches?focus=${esc(r.created.batchId)}">查看批次详情</a>
    </div></div>`;
  }
  return `<div class="card" style="border-color:color-mix(in srgb,var(--critical) 32%,var(--line))"><div class="card-body">
    <div class="note critical" style="margin-bottom:12px"><span class="i">✕</span><div><strong>采集被阻断</strong><br />${esc(r.message)}</div></div>
    <dl class="kv">
      <dt>原因码</dt><dd>${pill(r.code ?? '—', 'critical')}</dd>
      <dt>批次号</dt><dd class="mono">${esc(r.created?.batchId ?? '—')}</dd>
      <dt>入库记录</dt><dd>0（阻断批次不写入任何记录）</dd>
      ${r.extra?.allowedFields ? `<dt>允许字段</dt><dd>${r.extra.allowedFields.map((f) => `<span class="chip mono">${esc(f)}</span>`).join(' ')}</dd>` : ''}
    </dl>
    <p class="xsmall muted" style="margin-top:10px">阻断尝试同样写入审计（ingest.blocked），批次记录保留阻断原因码便于追溯。</p>
    ${r.created?.batchId ? `<a class="btn sm" style="margin-top:10px" href="#/batches?focus=${esc(r.created.batchId)}">查看阻断批次</a>` : ''}
  </div></div>`;
}
