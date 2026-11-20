/**
 * UI 端到端测试（可选，需要 Playwright 与 Chromium）。
 *
 *   PLAYWRIGHT_MODULE=/tmp/browsercheck/node_modules/playwright \
 *   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
 *   node test/e2e.ui.mjs
 *
 * 会用临时数据库 + 随机端口拉起真实服务，逐页检查渲染、控制台错误，
 * 并操作"重复通知 / 中断恢复 / 撤回阻断"三条主路径。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

const modulePath = process.env.PLAYWRIGHT_MODULE ?? 'playwright';

/** playwright 是 CJS 包：按目录导入时要用 index.js，且 chromium 在 default 上。 */
async function loadChromium() {
  const candidates = [modulePath];
  if (!modulePath.startsWith('file:')) candidates.push(pathToFileURL(join(modulePath, 'index.js')).href);
  let lastErr;
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      const api = mod.chromium ? mod : mod.default;
      if (api?.chromium) return api.chromium;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('playwright 未导出 chromium');
}

let chromium;
try {
  chromium = await loadChromium();
} catch (err) {
  console.log(`skip: 未找到 Playwright（${err.code ?? err.message}）。设置 PLAYWRIGHT_MODULE 后重试。`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'consent-e2e-'));
const db = openDb(join(dir, 'e2e.db'));
const app = createApp({ db });
await new Promise((r) => app.server.listen(0, r));
const base = `http://127.0.0.1:${app.server.address().port}`;

// 造一个可操作的种子主体 + 一个处于 paused 的处置任务
db.prepare('INSERT INTO subjects (id, name, channel, contact_hint, created_at) VALUES (?,?,?,?,?)').run(
  'sub_e2e',
  '端到端主体',
  'App',
  '138****8888',
  new Date(Date.now() - 86400000 * 90).toISOString(),
);
const { applyConsentNotice, createBatch, sealBatch, runJob } = await import('../src/ledger.js');

applyConsentNotice(db, {
  subjectId: 'sub_e2e',
  noticeKey: 'E2E-BASE',
  purposes: ['analytics', 'personalization'],
  scopes: ['contact', 'behavior'],
  retentionDays: 120,
});
for (const purpose of ['personalization', 'personalization', 'analytics']) {
  const b = createBatch(db, {
    subjectId: 'sub_e2e',
    purpose,
    scopes: ['behavior'],
    fields: ['behavior'],
    source: '端到端采集器',
    records: Array.from({ length: 4 }, (_, i) => ({ behavior: `事件 ${i}` })),
  });
  sealBatch(db, b.batchId);
}
const narrowing = applyConsentNotice(db, {
  subjectId: 'sub_e2e',
  noticeKey: 'E2E-NARROW',
  purposes: ['analytics'],
  scopes: ['behavior'],
  retentionDays: 120,
  reason: '端到端：关闭个性化推荐',
});
runJob(db, narrowing.job.id, { chunkSize: 1, failAfter: 1, interruptMessage: '端到端模拟中断' });

const failures = [];
const consoleErrors = [];
const check = (cond, label) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR ${e.message}`));

const goto = async (hash) => {
  await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
};

try {
  console.log('页面渲染');
  for (const [name, hash] of [
    ['总览', '#/overview'],
    ['授权与主体', '#/subjects'],
    ['采集批次', '#/batches'],
    ['处置任务', '#/jobs'],
    ['隔离区', '#/vault'],
    ['审计记录', '#/audit'],
    ['验证中心', '#/drill'],
    ['接入模拟器', '#/ingest'],
  ]) {
    await goto(hash);
    const h1 = (await page.locator('h1').first().textContent())?.trim();
    check(!!h1, `${name} 渲染标题（${h1 ?? '空'}）`);
  }

  console.log('重复通知：同条款换 key 返回 duplicate_terms');
  const dup = await page.evaluate(async () => {
    const res = await fetch('/api/consent/notices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectId: 'sub_e2e',
        noticeKey: `E2E-DUP-${Date.now()}`,
        purposes: ['analytics'],
        scopes: ['behavior'],
        retentionDays: 120,
      }),
    });
    return { status: res.status, body: await res.json() };
  });
  check(dup.body.outcome === 'duplicate_terms', `重复条款被识别为 ${dup.body.outcome}`);

  console.log('处置任务页：暂停任务 + 恢复按钮');
  await goto('#/jobs');
  const pausedRow = page.locator('tr', { hasText: '已中断' }).first();
  check((await pausedRow.count()) > 0, '列表出现「已中断 · 待恢复」任务');
  await pausedRow.click();
  await page.waitForTimeout(400);
  const resumeBtn = page.locator('[data-act="resume"]').first();
  check((await resumeBtn.count()) > 0, '详情页提供「恢复执行」');
  await resumeBtn.click();
  await page.waitForTimeout(800);
  const statusText = await page.locator('.page-head').first().textContent();
  check(/已完成|执行中/.test(statusText), `恢复后状态推进（${statusText?.trim().slice(0, 40) ?? ''}）`);

  console.log('验证中心：三个场景可运行');
  await goto('#/drill');
  for (const label of ['重复通知幂等', '处置中断与恢复', '撤回后阻断采集']) {
    const card = page.locator('.card', { hasText: label }).first();
    await card.locator('[data-run]').click();
    await page.waitForFunction(
      (t) => document.body.innerText.includes(`${t}`) && !document.body.innerText.includes('运行中…'),
      label,
      { timeout: 15000 },
    );
    await page.waitForTimeout(300);
  }
  const verdicts = await page.locator('.verdict').allTextContents();
  check(verdicts.length === 3 && verdicts.every((v) => v.includes('全部通过')), `三个场景全部通过（${verdicts.join(' / ')}）`);
  const badSteps = await page.locator('.step.bad').count();
  check(badSteps === 0, '没有失败断言');

  console.log('接入模拟器：撤回主体提交被阻断');
  await page.evaluate(() =>
    fetch('/api/consent/notices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectId: 'sub_e2e',
        noticeKey: `E2E-REVOKE-${Date.now()}`,
        status: 'revoked',
        purposes: [],
        scopes: [],
        retentionDays: 0,
      }),
    }),
  );
  await goto('#/ingest?subject=sub_e2e');
  await page.locator('#submit').click();
  await page.waitForTimeout(900);
  const result = await page.locator('.note.critical').allTextContents();
  check(result.some((t) => t.includes('阻断')), '接入模拟器显示阻断结果');

  check(consoleErrors.length === 0, `无控制台错误${consoleErrors.length ? `：${consoleErrors.join(' | ')}` : ''}`);
} catch (err) {
  failures.push(`异常：${err.message}`);
  console.error(err);
} finally {
  await browser.close();
  await new Promise((r) => app.server.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n端到端失败 ${failures.length} 项：\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\n端到端全部通过');
