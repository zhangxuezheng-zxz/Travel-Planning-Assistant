# 问题清单（bug.md）

> 由 8 份历史文档（11.15–11.19）精简合并：`11.18待完成问题`、`11.18改动`、`11.18晚发现问题`、`第一次检查前任务总览`、`测试任务手册`、`待完成-测试联调`、`待完成-前端页面`、`待完成-外部API`。
> 2026-11-26 已逐条对照当前 main（`3c6737d`）代码核实。状态：✅ 已解决　⚠️ 部分解决　❌ 未解决　📌 待决策

## 一、已解决（留档，防止重复跟进）

| 问题 | 处理结果 | 证据（文件/位置） |
| --- | --- | --- |
| 两个指向不存在接口的死方法 `recommendPlaces` / `getProposal` | 已删除 | `trip-draft-client.ts` 无引用 |
| 附件上限只写在文案（9 个） | 前端按剩余名额截断 + 提交前总大小预检；上限提到 100 个 / 300 MiB | `FootprintEntryForm.tsx` L9-L12 |
| 定位失败只有一句话 | 按 `GeolocationPositionError.code` 给出可行动提示 | `apps/web/src/lib/geo-error.ts` |
| 自驾/公交无 Key 报「缺少必要站点间路线」 | 改为提示配置 `AMAP_WEB_SERVICE_KEY` 或改步行 | `trip-errors.ts` planningErrorMessage |
| 行程「去过」与足迹两套数据 | 「去过/预约/住宿/行李」入库 `trip_state`，勾选时自动生成/删除足迹 | `trip-state.service.ts`、迁移 `202611180002` |
| 错误契约不统一（4xx 只有「请求未能处理」） | 4xx 保留中文原因，5xx 通用文案 | `api-exception.filter.ts` |
| 注册不返回 token | 注册/登录同形状 `{ accessToken, expiresAt, user }` | `auth.service.ts` `issueSession` |
| 演示数据带「（演示）」字样 | 改为真实景点名（西湖·花港观鱼、灵隐飞来峰、良渚博物院） | `docs/examples/demo-scenario.json` |
| 足迹/手账/地图未挂进正式 App | AppShell 四页（旅行助手/行程/足迹/我的）；足迹页三视图 | `AppShell.tsx`、`FootprintPage.tsx` |
| 地图页无全国点位/年份筛选 | `AtlasMap` + `includeLocations=true` + 年份筛选 | `FootprintMapView.tsx` |
| 手账图片直接当 `<img src>` 会 401 | 改为 `fetch` + Blob URL 显示 | `JournalPage.tsx` |

## 二、仍存在的问题

### P1 — 影响演示/验收

| # | 问题 | 现状 | 建议 |
| --- | --- | --- | --- |
| 1 | 首页「旅行灵感」对话仍是本地正则，未接后端模型 | `HomePage.generateReply()` 纯本地分支，不发请求 | 📌 接 `/recommendations/itinerary` 或沿用 |
| 2 | 提醒（reminders）仍存 `localStorage`，未入库 | `trip-reminders.ts` 读写 `wander-reminders:*` | 拆「规划期(本地) / 行程后(服务端)」两个入口，约半天 |
| 3 | 本工作区 `.env` 未填高德两个 Key | `VITE_AMAP_WEB_KEY`、`AMAP_WEB_SERVICE_KEY` 为空 | 填入已申请的 Key；自驾/公交路线仍待验证 |
| 4 | 移动端/响应式未实测 | 390/768/1280 三个宽度无记录 | 按 T11 补测并截图 |
| 5 | 数据仅 2 城 21 景点（北京 18 + 杭州 3） | 首页与推荐偏空 | 补城市/景点或换演示城市 |
| 6 | 删除手账不清理孤儿图片 | `journals.service` 只删 `journal_media`，`media_assets` 与文件残留 | 级联删除或定时清理 |

### P2 — 风险/体验

| # | 问题 | 现状 |
| --- | --- | --- |
| 7 | 100 附件 + 300 MiB 上限，但 multer 内存存储先读后拒 | 已知风险；正常使用受 300 MiB 阈值保护 |
| 8 | 行程删除后已生成足迹保留 | 按「删除行程不删真实到访」约定，可不改 |

### 测试缺口 — 验收主要风险

| # | 缺口 | 现状 |
| --- | --- | --- |
| 9 | 前端渲染测试 0、端到端联调 0 | 12 个前端测试均为纯逻辑（node --test + transpile） |
| 10 | 47 条联调用例（P15/J19/X8/D5）从未执行 | 无执行记录 |
| 11 | 契约测试缺失（错误码逐条断言） | 无 `contract.test.cjs` |
| 12 | `acceptance-c.cjs` 未接入 CI | workflow 仅跑 npm test + 2 个 verify 脚本 |
| 13 | 真实高德 Key 专项（三类路线+逆地理）未全验 | 仅逆地理 + 步行路线验证过 |
| 14 | 数据库备份/恢复演练、验收证据归档为 0 | 无 |
| 15 | `APP_Test`（222 条全软件用例）未执行、不在 CI | CI 路径只覆盖 `travel-planner-v2-framework/**` |

## 三、待决策

1. **大模型是否启用**：`B_LLM_ENABLED=false`。建议不上（规则算法可完整走通，LLM 只影响游览顺序）。
2. **提醒入库方案**：拆本地/服务端两个数据入口（见 P1-2）。
3. **数据规模**：是否补充更多城市/景点。

## 四、验证依据

- 代码核实：以上文件均按 `3c6737d` 打开确认（2026-11-26）。
- 测试规模：API 测试 18 个文件、前端逻辑测试 12 个文件，CI 全跑。
- 环境：本工作区 `.env` 存在；高德 Key 为空（另一工作区已填并验证过逆地理与步行路线）。
