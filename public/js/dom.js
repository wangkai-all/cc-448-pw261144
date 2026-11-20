/* 轻量 DOM / 格式化工具 */

export const esc = (v) =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export const html = (strings, ...values) =>
  strings.reduce((acc, s, i) => acc + s + (i < values.length ? (values[i] ?? '') : ''), '');

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const icons = {
  overview: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="2.5" width="6" height="6" rx="1.4"/><rect x="11.5" y="2.5" width="6" height="6" rx="1.4"/><rect x="2.5" y="11.5" width="6" height="6" rx="1.4"/><rect x="11.5" y="11.5" width="6" height="6" rx="1.4"/></svg>',
  subjects: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="6.5" r="3.2"/><path d="M3.6 16.4c.8-3 3.3-4.6 6.4-4.6s5.6 1.6 6.4 4.6" stroke-linecap="round"/></svg>',
  batches: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 5.4 10 2l7 3.4v9.2L10 18l-7-3.4z" stroke-linejoin="round"/><path d="M3 5.4 10 8.8l7-3.4M10 8.8V18"/></svg>',
  jobs: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7.2"/><path d="M10 6v4.3l2.8 1.7" stroke-linecap="round"/></svg>',
  vault: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.8" y="3.4" width="14.4" height="13.2" rx="2"/><circle cx="10" cy="10" r="2.6"/><path d="M10 7.4V10l1.7 1.2" stroke-linecap="round"/></svg>',
  audit: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 2.6h7l3 3v11.8H5z" stroke-linejoin="round"/><path d="M12 2.8v3.2h3.2M7.5 9.5h5M7.5 12.4h5M7.5 15.2h3" stroke-linecap="round"/></svg>',
  drill: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 2.4 16.6 5v5c0 4-2.8 6.6-6.6 7.6C6.2 16.6 3.4 14 3.4 10V5z" stroke-linejoin="round"/><path d="m7.2 10 2 2 3.8-4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ingest: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 2.8v9.4M6.4 8.8 10 12.4l3.6-3.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.2 13.4v2.4c0 .8.6 1.4 1.4 1.4h10.8c.8 0 1.4-.6 1.4-1.4v-2.4" stroke-linecap="round"/></svg>',
  refresh: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M16 10a6 6 0 1 1-1.9-4.4" stroke-linecap="round"/><path d="M16.2 3v3.4h-3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevron: '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m8 5 5 5-5 5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="9" r="5.4"/><path d="m13.4 13.4 3 3" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m5 5 10 10M15 5 5 15" stroke-linecap="round"/></svg>',
  play: '<svg class="ico" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 4.2v11.6l9-5.8z"/></svg>',
  pause: '<svg class="ico" viewBox="0 0 20 20" fill="currentColor"><rect x="5.4" y="4.2" width="3.2" height="11.6" rx="1"/><rect x="11.4" y="4.2" width="3.2" height="11.6" rx="1"/></svg>',
  shield: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 2.4 16.6 5v5c0 4-2.8 6.6-6.6 7.6C6.2 16.6 3.4 14 3.4 10V5z" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 10h11M11 6l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export function icon(name) {
  return icons[name] ?? '';
}

const DATE_FMT = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const FULL_FMT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const TIME_FMT = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function fmtDate(iso) {
  if (!iso) return '—';
  return DATE_FMT.format(new Date(iso));
}
export function fmtFull(iso) {
  if (!iso) return '—';
  return FULL_FMT.format(new Date(iso));
}
export function fmtTime(iso) {
  if (!iso) return '—';
  return TIME_FMT.format(new Date(iso));
}
export function fmtRelative(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return diff >= 0 ? `${mins} 分钟前` : `${mins} 分钟后`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return diff >= 0 ? `${hours} 小时前` : `${hours} 小时后`;
  const days = Math.round(hours / 24);
  if (days < 30) return diff >= 0 ? `${days} 天前` : `${days} 天后`;
  return fmtDate(iso);
}
export function fmtNum(n) {
  return new Intl.NumberFormat('zh-CN').format(Number(n) || 0);
}
export function pct(a, b) {
  if (!b) return 0;
  return Math.round((a / b) * 100);
}
export function plural(n, unit) {
  return `${fmtNum(n)} ${unit}`;
}

export const STATUS_META = {
  pending: { label: '待执行', tone: 'warn' },
  running: { label: '执行中', tone: 'info' },
  paused: { label: '已中断 · 待恢复', tone: 'serious' },
  failed: { label: '失败', tone: 'critical' },
  completed: { label: '已完成', tone: 'good' },
  cancelled: { label: '已取消', tone: 'plain' },
};

export const BATCH_META = {
  collecting: { label: '采集中', tone: 'info' },
  sealed: { label: '已封存', tone: 'good' },
  blocked: { label: '已阻断', tone: 'critical' },
  degraded: { label: '已降级', tone: 'warn' },
  quarantined: { label: '已隔离', tone: 'serious' },
  deleted: { label: '已删除', tone: 'plain' },
};

export const ACTION_META = {
  delete: { label: '删除', tone: 'critical' },
  quarantine: { label: '隔离', tone: 'serious' },
  degrade: { label: '降级', tone: 'warn' },
  none: { label: '无需处置', tone: 'plain' },
  mixed: { label: '混合处置', tone: 'info' },
};

export const TRIGGER_META = {
  consent_narrowed: { label: '授权收窄', tone: 'warn' },
  consent_revoked: { label: '授权撤回', tone: 'critical' },
  consent_widened: { label: '授权放宽', tone: 'good' },
  retention_policy: { label: '保留期缩短', tone: 'serious' },
  retention_sweep: { label: '保留期到期', tone: 'plain' },
  manual: { label: '人工触发', tone: 'plain' },
};

export function pill(label, tone = 'plain', { dot = false, title } = {}) {
  return `<span class="pill ${tone}"${title ? ` title="${esc(title)}"` : ''}>${dot ? '<i class="dot"></i>' : ''}${esc(label)}</span>`;
}

export function actionTag(action) {
  const m = ACTION_META[action] ?? { label: action, tone: 'plain' };
  return `<span class="action-tag ${action}">${esc(m.label)}</span>`;
}

export function chipList(items, fn = (x) => x) {
  return items.map((x) => chip(fn(x))).join(' ');
}

export function AUDIT_KIND(action) {
  if (action.includes('delete') || action.includes('revoked') || action.includes('purged')) return 'delete';
  if (action.includes('blocked') || action.includes('flagged') || action.includes('skipped')) return 'block';
  if (action.startsWith('consent')) return 'consent';
  if (action.includes('completed')) return 'complete';
  return 'default';
}

export function chip(text, cls = '') {
  return `<span class="chip ${cls}">${esc(text)}</span>`;
}

export function progressBar(value, max, tone = '') {
  const p = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return `<div class="progress ${tone}" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></div>`;
}

export function statusPill(status, meta = STATUS_META) {
  const m = meta[status] ?? { label: status, tone: 'plain' };
  return pill(m.label, m.tone, { dot: true });
}

export function copyToClipboard(text) {
  return navigator.clipboard?.writeText(text) ?? Promise.resolve();
}
