# 授权快照数据接入层

每次采集批次在创建时冻结当时的授权快照（用途 / 范围 / 保留期）。授权收窄或撤回后，新采集被**阻断**；已入库数据按影响范围进入**删除 / 降级 / 隔离**队列，处置直接改写 `records`、`batches`、`vault_*` 表——不是查询层过滤。

零运行时依赖，只用 Node 内置模块（`node:http`、`node:sqlite`）。前端是无构建步骤的原生 ES Module 单页应用。

## 运行

```bash
npm run seed     # 写入演示数据（可重复执行，空库才播种）
npm start        # http://localhost:4173
npm test         # 43 个后端断言（node --test，内存库）
npm run test:e2e # 可选：Playwright UI 端到端（需 PLAYWRIGHT_MODULE）
```

要求 Node ≥ 22.5（`node:sqlite` 的 `DatabaseSync`）。数据文件默认 `data/ledger.db`，可用 `DB_FILE` 覆盖。

## 不变式

1. **快照不可变**：`snapshots` 只插入不更新。`version` 单调递增，`terms_hash = sha256(canonicalJson({status, sorted(purposes), sorted(scopes), retentionDays}))`，`prev_id` 串成版本链。相同条款换 `notice_key` 重发不会产生新版本。
2. **批次只绑定创建时的快照**：`batches.snapshot_id / snapshot_version / terms_hash` 在创建时写入，之后授权变化不会回写批次，而是生成处置任务。
3. **处置落到数据本身**：
   - `delete` — `DELETE FROM records`，批次置 `deleted`，`record_count = 0`；
   - `degrade` — 就地从每条记录的 JSON payload 中删除失权字段，`state = 'degraded'`，批次字段/范围同步收窄；
   - `quarantine` — 记录复制进 `vault_entries` 后从 `records` 删除，批次置 `quarantined`，查询接口读不到。
   - `queryRecords()` 里的 `WHERE` 只是兜底；测试直接对 `records` 表计数证明行已消失。

## 处置决策（`decideBatchAction`）

| 变化 | 结果 |
| --- | --- |
| 整体撤回 | 整批 `delete` |
| 批次用途失权 | 整批 `delete` |
| 部分字段失权，剩余字段仍授权，失权范围含高风险（联系方式 / 精确定位 / 语音） | `quarantine` |
| 部分字段失权，非高风险 | `degrade`（仅抹除失权字段） |
| 全部字段失权 | `delete` |
| 仅保留期缩短 | 清除 `captured_at < cutoff` 的记录，其余保留 |
| 授权放宽 | 不生成任务，只写 `consent.widened` 审计 |
| 批次处于法务保全 | 目标置 `skipped`，写 `disposition.skipped_hold` 升级审计 |

## 幂等与中断恢复

- `consent_notices.notice_key` 唯一 → 同一条通知重放返回 `duplicate_notice`；同一 key 指向另一主体报 `E_NOTICE_SUBJECT_CONFLICT`，不会静默吞掉串号通知。
- 条款哈希相同 → `duplicate_terms`，并写入 `status = 'suppressed'` 的通知记录（不重复下发）。
- `jobs.dedupe_key = disp:<subject>:<trigger>:<snapshotId>` 唯一 → 快照已落库但规划前崩溃，重规划只命中已有任务。
- `job_targets` 是按批次落库的顺序队列（`ord`）。`runJob` 按 `chunkSize` 分批执行，中断时写 `checkpoint = {nextOrd, processedBatches, processedRecords}` 并把任务置 `paused`；`resumeJob` 从最小 `pending` 的 `ord` 继续，`done` 目标不会重复处理。
- `failed` 目标由 `retryJob` 重置为 `pending`；已完成任务再次执行是 no-op。
- 通知出队 `notices.dedupe_key` 唯一，`flushNotices` 只处理 `queued`。

## 页面

| 路由 | 内容 |
| --- | --- |
| `#/overview` | KPI、处置队列与进度、动作分布、暂停任务一键恢复 |
| `#/subjects` `#/subject/:id` | 授权版本链、条款哈希、批次绑定快照、受影响批次与处置进度 |
| `#/batches` | 批次列表（状态 / 绑定快照 / 处置动作），阻断批次可追溯原因码 |
| `#/jobs` `#/job/:id` | 持久化目标队列、进度、检查点、执行 / 恢复 / 重试、逐步审计 |
| `#/vault` | 隔离副本、法务保全 |
| `#/audit` | 追加写审计，可按动作类型 / 主体 / 关键字筛选 |
| `#/drill` | 验证中心：三个场景逐步断言，直接查库给证据 |
| `#/ingest` | 接入模拟器：走真实 `createBatch` / `seal` 路径复现阻断 |

## 测试

`test/*.test.js`（`npm test`）：

- `snapshot.test.js` — 快照不可变、哈希归一化、非法条款拒绝
- `ingest.test.js` — 批次绑定、撤回/超授权阻断、封存复查、补写拒绝
- `disposition.test.js` — 删除/隔离/降级/mixed/保留期/法务保全/副本清除/任务幂等
- `idempotency.test.js` — 重复通知三种形态、通知去重、分块、中断恢复、失败重试、人工暂停
- `retention.test.js` — 到期清理与 dry-run
- `vault.test.js` — 隔离副本恢复/清除、授权复核、法务保全
- `api.test.js` — 真实 HTTP 服务端到端、错误契约、验证中心场景可重复

`test/e2e.ui.mjs`（`npm run test:e2e`）：临时库 + 随机端口拉起服务，用真实 Chromium 检查 8 个页面渲染、控制台零错误，并操作重复通知、任务恢复、验证中心三个场景、撤回后阻断采集。

```bash
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers \
npm run test:e2e
```

## 目录

```
src/db.js       schema + 支持嵌套的 tx()（SAVEPOINT）
src/ledger.js   快照 / 接入 / 处置规划 / 执行器 / 保留期
src/drill.js    沙箱 sub_drill 的三个可重复验证场景
src/server.js   HTTP 路由 + 静态资源
public/         无构建 SPA（哈希路由）
scripts/seed.js 演示数据
test/           node --test + Playwright
```
