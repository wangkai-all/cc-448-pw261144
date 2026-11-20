import { $, el } from './dom.js';

const stack = () => $('#toast-stack');

export function toast(message, tone = '') {
  const node = el('div', { class: `toast ${tone}`, role: 'status' }, message);
  const close = el('span', { class: 'x', title: '关闭' }, '✕');
  close.addEventListener('click', () => node.remove());
  node.append(close);
  stack().append(node);
  setTimeout(() => node.remove(), 5200);
}

let activeDrawer = null;

export function openDrawer({ title, sub, body, foot, onClose, width }) {
  closeDrawer();
  const drawer = $('#drawer');
  const scrim = $('#drawer-scrim');
  drawer.innerHTML = '';
  if (width) drawer.style.width = width;
  drawer.append(
    el(
      'div',
      { class: 'drawer-head' },
      el(
        'div',
        { style: 'flex:1;min-width:0' },
        el('h2', {}, title),
        sub ? el('div', { class: 'sub' }, sub) : null,
      ),
      el('button', { class: 'icon-btn', 'aria-label': '关闭', onclick: () => closeDrawer() }, '✕'),
    ),
  );
  const bodyEl = el('div', { class: 'drawer-body' });
  if (body instanceof Node) bodyEl.append(body);
  else if (typeof body === 'function') bodyEl.append(body());
  else bodyEl.innerHTML = body ?? '';
  drawer.append(bodyEl);
  if (foot) {
    const footEl = el('div', { class: 'drawer-foot' });
    if (foot instanceof Node) footEl.append(foot);
    else footEl.innerHTML = foot;
    drawer.append(footEl);
  }
  drawer.hidden = false;
  scrim.hidden = false;
  scrim.onclick = closeDrawer;
  document.addEventListener('keydown', escHandler);
  activeDrawer = { onClose };
  $('.drawer-body', drawer)?.scrollTo?.(0, 0);
  return { bodyEl, drawer, close: closeDrawer };
}

function escHandler(e) {
  if (e.key === 'Escape') closeDrawer();
}

export function closeDrawer() {
  const drawer = $('#drawer');
  const scrim = $('#drawer-scrim');
  if (!drawer || drawer.hidden) return;
  drawer.hidden = true;
  scrim.hidden = true;
  drawer.innerHTML = '';
  document.removeEventListener('keydown', escHandler);
  const cb = activeDrawer?.onClose;
  activeDrawer = null;
  cb?.();
}

export function closeAllOverlays() {
  closeDrawer();
  document.querySelectorAll('.modal-scrim').forEach((n) => n.remove());
}

export function openModal({ title, desc, body, confirmText = '确认', cancelText = '取消', tone = 'primary', onConfirm, width }) {
  const scrim = el('div', { class: 'modal-scrim' });
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  if (width) modal.style.width = width;
  modal.append(
    el(
      'div',
      { class: 'modal-head' },
      el('h2', {}, title),
      desc ? el('p', {}, desc) : null,
    ),
  );
  const bodyEl = el('div', { class: 'modal-body' });
  if (body instanceof Node) bodyEl.append(body);
  else bodyEl.innerHTML = body ?? '';
  modal.append(bodyEl);

  const foot = el('div', { class: 'modal-foot' });
  const cancel = el('button', { class: 'btn', onclick: close }, cancelText);
  const confirm = el('button', { class: `btn ${tone}`, onclick: async () => {
    confirm.disabled = true;
    try {
      const r = await onConfirm?.({ close, modal, confirm });
      if (r !== false) close();
    } finally {
      confirm.disabled = false;
    }
  } }, confirmText);
  foot.append(cancel, confirm);
  modal.append(foot);
  scrim.append(modal);
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) close();
  });
  document.body.append(scrim);
  function close() {
    scrim.remove();
  }
  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', keyHandler);
    }
  };
  document.addEventListener('keydown', keyHandler);
  setTimeout(() => confirm.focus(), 30);
  return { close, bodyEl, confirm, modal };
}
