# B 验收汇总（地点目录 / 地图适配 / 智能推荐）

> 合并压缩自：`B-开发计划.md`、`B-全面验收与开源模型.md`、`B-完整测试流程与用例.md`、`B-开发与全面验收汇总.md`（原 16142 行）。合并时间 2026-11-26。
> 原始验收物证（命令输出、HTTP 证据、模型 prompt、截图）见 [`history/acceptance/B-20261102-full`](../history/acceptance/B-20261102-full/README.md)。

## 一、验收结论（2026-11-02）

| 项目                          | 结果                 | 说明                                                |
| ----------------------------- | -------------------- | --------------------------------------------------- |
| 代码与工程检查                | 12/12 命令组退出码 0 | lint、typecheck、build、format、Git diff 检查、测试 |
| 快速测试                      | 42/42                | 含原有 11 项基础测试，并非 42 个接口                |
| 真实数据库集成                | 7/7 场景             | 专用 `_test` 库随机 schema，测试后清理              |
| 扩展 HTTP / 数据库 / 模型场景 | 79/79                | 每场景状态、耗时与请求响应已保存                    |
| 生产入口 HTTP smoke           | 14/14                | health/ready + 六接口匿名/伪造 token 拒绝           |
| 真实模型调用                  | 3 次均 HTTP 200      | 中文文本回复；结构化模型+保存；无地图 Key 模型+保存 |

测试集合存在交叉覆盖，不能相加为"独立功能总数"；结论仅限已执行场景。

## 二、六个公开接口（前缀 `/api`，均需服务端认证）

| 方法与路径                      | 输入                                                        | 返回                                        |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| GET /destinations               | level?、parentId?、keyword?、page?、pageSize?               | Destination 分页                            |
| GET /places                     | cityId 必填；keyword?、category?、themes?、page?、pageSize? | Place 分页；themes 为逗号分隔               |
| GET /places/:id                 | 平台地点 UUID                                               | Place；未知地点 404                         |
| POST /routes/preview            | { from, to, transportMode }                                 | { durationMinutes, source, warnings }       |
| POST /locations/reverse         | { coordinates }                                             | { placeName, cityId, cityAdcode, warnings } |
| POST /recommendations/itinerary | PlanningInput                                               | Proposal（只生成/保存，不写正式 trips）     |

## 三、实现范围与关键行为

- **目录**：省/市、父级筛选、关键词、类别、主题排序、稳定分页与详情；参数化 SQL。
- **规则推荐**：单城市 1–30 天、1–120 个景点、三节奏；交通/休息/日预算；完整性与未安排说明。
- **地图适配**：步行/驾车/公交；逆地理与 GPS 转换；citycode/adcode 区分；错误与超时校验。
- **有依据的降级**：≤5 km 短距离步行可 estimate；缺失必要路线返回 503 或另日安排。
- **方案持久化**：不可变输入快照、所有者、生成/到期时间、重启重读、他人 404。
- **模型增强**：仅允许原景点 ID 完整排列；确有改进才采用；失败保留规则方案。

## 四、真实依赖与复现

- 数据库：服务器 Docker PostgreSQL 17（SSH 隧道连接，本地 Node.js）。
- 模型：Ollama 0.13.5 + Qwen2.5-0.5B（Q4_K_M，CPU 推理，单并发，限内存/CPU）。
- 本地 `.env`：`B_LLM_ENABLED=true`、`LLM_API_BASE_URL=http://127.0.0.1:11434/v1`、`LLM_MODEL=qwen2.5:0.5b`、`LLM_API_KEY=ollama-local`、`B_LLM_TIMEOUT_MS=45000`。
- 一键验收：`npm run acceptance:b -- --real-model --output docs/acceptance/B-新目录`（不覆盖已有 `run.json`）。

## 五、本轮实际发现与修复

1. 真实模型首轮只返回 2 个景点 → 完整性校验正确回退；补 `minItems/maxItems` 约束，并在 prompt 明确完整 ID 列表与"每项一次"。
2. 补齐约束后 CPU 推理超过原 15 秒共享超时 → 新增独立 `B_LLM_TIMEOUT_MS`，保留全局生成截止时间；超时不计为成功。
3. 验收脚本缺少扩展业务矩阵且同目录可覆盖 → 新增全面场景接入一键验收，拒绝覆盖已有 `run.json`。

## 六、待验收项

| 内容             | 现状                                                      | 完成条件                                                 |
| ---------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| 高德正式服务     | 适配器已用可控 HTTP 服务测过；正式 Key/权限与实际结果未测 | 提供有效服务端 Key，实测步行/驾车/公交、逆地理、GPS 转换 |
| C 真实登录接线   | 生产 B 默认拒绝；正向验收注入测试身份                     | C 实现真实令牌验证并注册 `B_AUTHENTICATOR`               |
| A/C 正式行程确认 | B 已生成、保存并提供 ProposalReader；未确认成 Trip        | 实测归属、过期、输入快照、未安排项与 revision 并发       |
| D 页面与到访     | D 页面流程未测                                            | D 完成消费方并联合验收                                   |

## 七、测试流程（历史版本，现由 CI 与 bug.md 取代）

原 `B-完整测试流程与用例.md`（293 行）描述三轮人工流程：① 现有自动化（lint/format/typecheck/build/test + verify 脚本）；② 起 API 做手动 HTTP 检查（Postman 32 个请求）；③ C 接通认证后的业务用例。

当前状态：自动化检查已并入 CI；手动用例以 [`examples/B-接口测试.postman_collection.json`](../examples/B-接口测试.postman_collection.json) 与仓库根 `docs/branches/bug.md` 为准。
