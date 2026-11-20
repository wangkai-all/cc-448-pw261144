import { get, post, meta, purposeLabel, scopeLabel } from '../api.js';
import { esc, el, fmtFull, pill } from '../dom.js';
import { openModal, toast } from '../ui.js';

/**
 * 录入授权通知 / 撤回。
 * 提交后立刻展示服务端回执：accepted / duplicate_notice / duplicate_terms 与生成的处置任务。
 */
export async function openConsentModal({ subject, onDone }) {
  const m = await meta();
  const current = subject.snapshot;

  const purposes = new Set(current?.status === 'active' ? current.purposes : []);
  const scopes = new Set(current?.status === 'active' ? current.scopes : []);
  let retention = current?.retentionDays ?? 180;
  let isRevoked = false;

  const body = el('div', {});
  body.innerHTML = `
    <div class="note info" style="margin-bottom:16px">
      <span class="i">i</span>
      <div>提交后系统会比对新条款与当前快照：只有条款变化才生成新版本。收窄 / 撤回会计算受影响的已入库批次，进入删除、降级或隔离队列——不会只在查询层隐藏。</div>
    </div>
    <div class="field">
      <label>变更类型</label>
      <div class="segmented" id="kind">
        <button data-v="narrow" class="on">收窄 / 调整</button>
        <button data-v="revoke">整体撤回</button>
      </div>
    </div>
    <div id="terms">
      <div class="field">
        <label>授权用途</label>
        <div class="check-grid" id="purposes">
          ${m.purposes
            .map(
              (p) => `<label class="check ${purposes.has(p.key) ? 'on' : ''}" data-key="${p.key}">
                <input type="checkbox" ${purposes.has(p.key) ? 'checked' : ''} />
                <span><span class="t">${esc(p.label)}</span><span class="d">${esc(p.desc)}</span></span>
              </label>`,
            )
            .join('')}
        </div>
      </div>
      <div class="field">
        <label>数据范围</label>
        <div class="check-grid" id="scopes">
          ${m.scopes
            .map(
              (sc) => `<label class="check ${scopes.has(sc.key) ? 'on' : ''}" data-key="${sc.key}">
                <input type="checkbox" ${scopes.has(sc.key) ? 'checked' : ''} />
                <span><span class="t">${esc(sc.label)}${sc.risk === 'high' ? ' · 敏感' : ''}</span><span class="d">${esc(sc.desc)}</span></span>
              </label>`,
            )
            .join('')}
        </div>
      </div>
      <div class="field">
        <label>保留期限</label>
        <div class="row">
          <input class="input" id="retention" type="number" min="1" max="730" value="${retention}" style="width:120px" />
          <span class="small muted">天（缩短会触发超期记录清除）</span>
        </div>
      </div>
    </div>
    <div class="field">
      <label>变更原因（写入审计）</label>
      <textarea class="textarea" id="reason" placeholder="例如：用户关闭个性化推荐、监管口径调整…">${esc(
        isRevoked ? '主体行使删除权，撤回全部授权' : '',
      )}</textarea>
    </div>
  `;

  const syncChecks = (container, set) => {
    container.querySelectorAll('.check').forEach((label) => {
      const input = label.querySelector('input');
      input.addEventListener('change', () => {
        label.classList.toggle('on', input.checked);
        if (input.checked) set.add(label.dataset.key);
        else set.delete(label.dataset.key);
      });
    });
  };
  syncChecks(body.querySelector('#purposes'), purposes);
  syncChecks(body.querySelector('#scopes'), scopes);

  body.querySelectorAll('#kind button').forEach((btn) => {
    btn.addEventListener('click', () => {
      body.querySelectorAll('#kind button').forEach((b) => b.classList.toggle('on', b === btn));
      isRevoked = btn.dataset.v === 'revoke';
      body.querySelector('#terms').style.display = isRevoked ? 'none' : '';
      body.querySelector('#reason').value = isRevoked
        ? '主体行使删除权，撤回全部授权并要求删除已采集数据'
        : '';
    });
  });

  const modal = openModal({
    title: '录入授权通知',
    desc: `${subject.name} · 当前快照 v${current?.version ?? '—'}（${current?.status === 'revoked' ? '已撤回' : current?.summary ?? ''}）`,
    body,
    confirmText: '提交并比对',
    width: '640px',
    onConfirm: async ({ modal, close }) => {
      const payload = {
        subjectId: subject.id,
        noticeKey: `UI-${Date.now().toString(36).toUpperCase()}`,
        purposes: isRevoked ? [] : [...purposes],
        scopes: isRevoked ? [] : [...scopes],
        retentionDays: isRevoked ? 0 : Number(body.querySelector('#retention').value) || 0,
        status: isRevoked ? 'revoked' : 'active',
        reason: body.querySelector('#reason').value.trim() || (isRevoked ? '授权撤回' : '授权调整'),
        source: 'console',
      };
      if (!isRevoked && (!payload.purposes.length || !payload.scopes.length)) {
        toast('请至少保留一个用途与一个范围，或选择整体撤回', 'critical');
        return false;
      }
      let res;
      try {
        res = await post('/api/consent/notices', payload);
      } catch (err) {
        toast(`提交失败：${err.message}`, 'critical');
        return false;
      }
      close();
      showReceipt(res, payload, onDone);
      return true;
    },
  });
  return modal;
}

export function showReceipt(res, payload, onDone) {
  const outcomeMap = {
    accepted: { tone: 'good', title: '已生成新授权快照' },
    duplicate_notice: { tone: 'info', title: '重复通知 · 已幂等吸收' },
    duplicate_terms: { tone: 'info', title: '条款未变化 · 未生成新版本' },
  };
  const o = outcomeMap[res.outcome] ?? { tone: 'plain', title: res.outcome };

  const body = el('div', {});
  body.innerHTML = `
    <div class="note ${o.tone === 'good' ? 'good' : 'info'}" style="margin-bottom:14px">
      <span class="i">${o.tone === 'good' ? '✓' : '↺'}</span>
      <div><strong>${o.title}</strong><br />${esc(res.message ?? '')}</div>
    </div>
    <dl class="kv" style="margin-bottom:16px">
      <dt>通知键</dt><dd class="mono">${esc(res.noticeKey)}</dd>
      <dt>快照版本</dt><dd>v${res.snapshot?.version ?? '—'} · ${res.snapshot?.status === 'revoked' ? '已撤回' : '有效'} · ${esc(res.snapshot?.summary ?? '')}</dd>
      <dt>条款哈希</dt><dd class="hash">${esc(res.snapshot?.termsHash?.slice(0, 24) ?? '—')}…</dd>
      <dt>生效时间</dt><dd>${fmtFull(res.snapshot?.effectiveAt)}</dd>
    </dl>
    ${
      res.job
        ? `<div class="section-title" style="margin-top:4px"><h2>生成的处置任务</h2></div>
           <div class="card" style="box-shadow:none"><div class="card-body">
             <div class="row wrap" style="gap:8px;margin-bottom:10px">
               ${pill(`影响 ${res.job.totalBatches} 个批次`, 'warn')}
               ${pill(`涉及 ${res.job.totalRecords} 条记录`, 'warn')}
               ${pill(res.job.triggerLabel, 'serious')}
             </div>
             <div class="stack">
               ${res.job.targets
                 .map(
                   (t) => `<div class="row" style="gap:8px;font-size:12px">
                     <span class="batch-id">${esc(t.batchId)}</span>
                     <span class="action-tag ${t.action}">${{ delete: '删除', quarantine: '隔离', degrade: '降级' }[t.action]}</span>
                     <span class="secondary truncate" style="flex:1" title="${esc(t.reason)}">${esc(t.reason)}</span>
                   </div>`,
                 )
                 .join('')}
             </div>
             <div class="row" style="margin-top:14px;gap:8px">
               <button class="btn primary sm" id="run-now">立即执行处置</button>
               <a class="btn sm" href="#/job/${esc(res.job.id)}" data-close>查看任务详情</a>
             </div>
           </div></div>`
        : res.outcome === 'accepted'
          ? `<div class="note good"><span class="i">✓</span><div>新授权对历史批次无影响，无需处置。</div></div>`
          : ''
    }
    <p class="xsmall muted" style="margin-top:14px">同一通知重复到达会被 noticeKey 幂等键拦截；相同条款换 key 重发会按条款哈希识别为重复。</p>
  `;

  const modal = openModal({
    title: '通知处理回执',
    body,
    confirmText: '完成',
    cancelText: '关闭',
    onConfirm: async () => {
      onDone?.();
    },
  });

  body.querySelector('#run-now')?.addEventListener('click', async () => {
    const btn = body.querySelector('#run-now');
    btn.disabled = true;
    btn.textContent = '执行中…';
    try {
      const r = await post(`/api/jobs/${res.job.id}/run`, { chunkSize: 3 });
      toast(
        r.job.status === 'completed'
          ? `处置完成：${r.job.processedBatches} 个批次 / ${r.job.processedRecords} 条记录`
          : `处置暂停：${r.job.lastError ?? '等待恢复'}`,
        r.job.status === 'completed' ? 'good' : 'critical',
      );
      modal.close();
      onDone?.();
    } catch (err) {
      toast(`执行失败：${err.message}`, 'critical');
      btn.disabled = false;
      btn.textContent = '立即执行处置';
    }
  });
  body.querySelectorAll('[data-close]').forEach((a) => a.addEventListener('click', () => modal.close()));
  return modal;
}

export async function openConsentForSubjectId(subjectId, onDone) {
  const s = await get(`/api/subjects/${encodeURIComponent(subjectId)}`);
  return openConsentModal({ subject: s, onDone });
}

void purposeLabel;
void scopeLabel;
