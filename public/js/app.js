import { el, $, icon } from './dom.js';
import { toast } from './ui.js';
import { meta, invalidate, get } from './api.js';
import { closeAllOverlays, closeDrawer } from './ui.js';
import overview from './views/overview.js';
import subjects from './views/subjects.js';
import subject from './views/subject.js';
import batches from './views/batches.js';
import jobs from './views/jobs.js';
import job from './views/job.js';
import vault from './views/vault.js';
import audit from './views/audit.js';
import drill from './views/drill.js';
import ingest from './views/ingest.js';

const routes = [
  { path: 'overview', view: overview, title: '总览', nav: 'overview', icon: 'overview' },
  { path: 'subjects', view: subjects, title: '授权与主体', nav: 'subjects', icon: 'subjects' },
  { path: 'subject', view: subject, nav: 'subjects' },
  { path: 'batches', view: batches, title: '采集批次', nav: 'batches', icon: 'batches' },
  { path: 'jobs', view: jobs, title: '处置任务', nav: 'jobs', icon: 'jobs' },
  { path: 'job', view: job, nav: 'jobs' },
  { path: 'vault', view: vault, title: '隔离区', nav: 'vault', icon: 'vault' },
  { path: 'audit', view: audit, title: '审计记录', nav: 'audit', icon: 'audit' },
  { path: 'drill', view: drill, title: '验证中心', nav: 'drill', icon: 'drill' },
  { path: 'ingest', view: ingest, title: '接入模拟器', nav: 'batches', icon: 'ingest' },
];

const navOrder = [
  { key: 'overview', label: '总览', icon: 'overview' },
  { key: 'subjects', label: '授权与主体', icon: 'subjects' },
  { key: 'batches', label: '采集批次', icon: 'batches' },
  { key: 'jobs', label: '处置任务', icon: 'jobs' },
  { key: 'vault', label: '隔离区', icon: 'vault' },
  { key: 'audit', label: '审计记录', icon: 'audit' },
  { key: 'drill', label: '验证中心', icon: 'drill' },
];

const app = {
  route: 'overview',
  params: [],
  badges: {},
};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart ?? ''));
  return { path: segs[0] ?? 'overview', params: segs.slice(1), query };
}

export function navigate(path, { replace = false } = {}) {
  const hash = `#/${path}`;
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
  if (replace) render();
}

export function refreshNavBadges(counts) {
  app.badges = counts;
  renderNav();
}

function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  const navItems = navOrder
    .map((item) => {
      const badge = app.badges[item.key];
      const badgeHtml = badge
        ? `<span class="badge ${item.key === 'jobs' && app.badges.jobsAlert ? 'alert' : ''}">${badge}</span>`
        : '';
      return `<a class="nav-item ${app.route === item.key || (item.key === 'subjects' && app.route === 'subject') || (item.key === 'jobs' && app.route === 'job') ? 'active' : ''}" href="#/${item.key}">${icon(item.icon)}<span>${item.label}</span>${badgeHtml}</a>`;
    })
    .join('');
  nav.insertAdjacentHTML(
    'beforeend',
    `${navItems}<div class="nav-group-label">工具</div><a class="nav-item ${app.route === 'ingest' ? 'active' : ''}" href="#/ingest">${icon('ingest')}<span>接入模拟器</span></a>`,
  );
}

async function render() {
  const { path, params, query } = parseHash();
  const def = routes.find((r) => r.path === path) ?? routes[0];
  app.route = def.path;
  app.params = params;

  $('#crumb').innerHTML = buildCrumb(def, params);
  renderNav();
  const view = $('#view');
  view.innerHTML = '<div class="empty"><p>加载中…</p></div>';

  try {
    await meta();
    await def.view({
      root: view,
      params,
      query,
      navigate,
      refresh: render,
      setCrumb: (html) => ($('#crumb').innerHTML = html),
      setActions: (html, bind) => setActions(html, bind),
      setHead: () => {},
    });
    setTitle(def.title ?? null);
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="empty"><div class="glyph">⚠</div><p>加载失败：${err.message}</p></div>`;
  }
  window.scrollTo(0, 0);
}

let actionBinders = null;
function setActions(html, bind) {
  const bar = $('#topbar-actions');
  bar.innerHTML = html ?? '';
  actionBinders = bind ?? null;
  if (bind) bind(bar);
}

function setTitle(title) {
  if (title) document.title = `${title} · 授权快照数据接入层`;
}

function buildCrumb(def, params) {
  const labels = {
    overview: '总览',
    subjects: '授权与主体',
    subject: '主体详情',
    batches: '采集批次',
    jobs: '处置任务',
    job: '处置详情',
    vault: '隔离区',
    audit: '审计记录',
    drill: '验证中心',
    ingest: '接入模拟器',
  };
  const navLabel = {
    overview: '总览',
    subjects: '授权与主体',
    batches: '采集批次',
    jobs: '处置任务',
    vault: '隔离区',
    audit: '审计记录',
    drill: '验证中心',
    ingest: '采集批次',
  }[def.path];
  let out = '';
  // 一级页面本身就在该导航项下，不再重复「采集批次 / 采集批次」
  if (navLabel && def.path !== 'overview' && navLabel !== labels[def.path]) {
    out += `<a href="#/${def.nav}">${navLabel}</a><span class="sep">/</span>`;
  }
  out += `<strong>${labels[def.path] ?? ''}</strong>`;
  if (params?.[0]) out += `<span class="sep">·</span><span class="mono" style="font-size:11.5px">${params[0]}</span>`;
  return out;
}

async function boot() {
  try {
    const ov = await get('/api/overview');
    const open = ov.jobs.filter((j) => ['paused', 'failed', 'pending', 'running'].includes(j.status)).length;
    const blocked = ov.subjects.filter((s) => s.batchCounts.blocked > 0).length;
    refreshNavBadges({
      subjects: ov.subjects.length,
      jobs: open || '',
      jobsAlert: open > 0,
      batches: ov.totals.batches,
    });
    void blocked;
  } catch {
    /* 首屏失败时代码不致命 */
  }
  await render();
}

window.addEventListener('hashchange', () => {
  closeAllOverlays();
  render();
});

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-nav]');
  if (link) {
    e.preventDefault();
    navigate(link.dataset.nav);
  }
});

$('#sidebar').addEventListener('click', (e) => {
  if (e.target.closest('a.nav-item')) closeDrawer();
});

// 供各视图调用：局部数据变更后刷新导航计数与页面
export async function refreshAll({ keepScroll = true } = {}) {
  invalidate();
  const y = window.scrollY;
  await boot();
  if (keepScroll) window.scrollTo(0, y);
}

void el;
export { boot };

boot();
