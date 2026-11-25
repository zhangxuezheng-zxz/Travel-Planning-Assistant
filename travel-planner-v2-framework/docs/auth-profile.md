# 登录鉴权与个人资料

此分支使用邮箱验证注册；手机号为可选绑定项，绑定并验证后可用于密码登录和找回。当前不提供仅手机号注册、短信免密登录或第三方登录。

## 本地启动

本次独立目录为 `Travel-Planning-Assistant-auth-profile/travel-planner-v2-framework`。
已准备的本机 `.env` 使用独立数据库 `travel_auth_profile_dev`、API 端口 3002、网页端口 5175，不复用原项目数据库。

```powershell
Set-Location -LiteralPath 'C:\Users\21202\Documents\ChatGPT\软件工程大作业\Travel-Planning-Assistant-auth-profile\travel-planner-v2-framework'
npm ci
npm run db:migrate
npm run dev:api
# 另一个 PowerShell 窗口：
npm run dev:web -- --host 127.0.0.1 --port 5175
```

浏览器打开 <http://127.0.0.1:5175>。
首次在其他机器运行，请先从 `.env.example` 创建 `.env` 并准备 PostgreSQL。
完整本地项目还可执行 `npm run db:seed:b`、`npm run db:seed:beijing` 导入演示城市和景点。

## 没有邮件或短信服务时

仅在本机联调中显式配置：

```dotenv
NODE_ENV=development
AUTH_DELIVERY_MODE=local
AUTH_TOKEN_SECRET=填写至少32字节的随机值并保持稳定
```

在注册/找回/绑定页面点击“获取验证码”，页面黄色区域会显示本地验证码。这里并未向真实邮箱/手机发送消息，也不能据此证明真实联系方式的归属。验证码仍经过随机生成、数据库摘要存储、用途校验、五分钟有效期、一次性消费及错误次数限制。
API 只绑定回环地址，并校验连接来源；生产环境或未指定开发/测试环境时禁止启用此模式。生产环境必须使用 `AUTH_DELIVERY_MODE=provider`。

## 真实邮件服务

```dotenv
AUTH_DELIVERY_MODE=provider
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=你的发件账号
SMTP_PASSWORD=邮箱授权码
SMTP_FROM=你的发件邮箱
```

587 端口通常配置 `SMTP_SECURE=false`，程序仍要求 STARTTLS 加密；不会关闭证书验证。
服务未配置或服务商拒绝发送会返回明确的 503 错误，不返回验证码。账号密钥仅写入已忽略的 `.env`，不要提交 Git。
使用 [Nodemailer SMTP 配置说明](https://nodemailer.com/smtp) 对照邮箱服务商的实际参数。

填写后可执行 `npm run auth:email:check`，只验证 SMTP 连接、TLS 和账号认证，不发送邮件，也不输出授权码。该命令成功不代表收件人已经收到邮件；仍需在注册页点击“获取验证码”，以实际收信完成验证。
本机真实发信时可设置 `API_HOST=127.0.0.1`，使 API 在切换 provider 模式后仍只接受本机连接。

2026-11-25 本机已接通 QQ 邮箱：SMTP 的连接、TLS 和账号认证检查通过，应用的注册验证码接口返回 200，QQ 服务器接受邮件，收件人已确认实际收到验证码。接口未返回 developmentCode，数据库仅保存验证码摘要。发件账号和授权码只在本机被 Git 忽略的 `.env` 中保存。

使用时打开注册页面，填写邮箱并点击“获取验证码”，把邮件里的六位验证码填回页面。验证码五分钟内有效，六十秒后可重新获取。后续邮箱找回、更换邮箱共用该真实邮件发送配置。

## 真实短信服务

已提供腾讯云短信适配器。需要申请短信应用、已审核签名及验证码模板：

```dotenv
TENCENT_SMS_SECRET_ID=
TENCENT_SMS_SECRET_KEY=
TENCENT_SMS_APP_ID=
TENCENT_SMS_SIGN_NAME=
TENCENT_SMS_TEMPLATE_ID=
```

模板使用两个参数，依次为“验证码”和“有效分钟数”，例如“您的验证码为{1}，{2}分钟内有效”。当前手机号校验仅支持中国大陆号码，保存为 `+86` 格式。
参考 [腾讯云 Node.js 短信 SDK](https://cloud.tencent.com/document/api/382/43197)。
短信发送账号尚未配置，真实短信投递尚未验收；不会使用本地测试码替代真实短信发送。

## 页面与行为

- 注册：邮箱 → 获取验证码 → 昵称、密码、确认密码 → 验证并注册，成功后登录。
- 旧账号：不会把已有邮箱自动标记为已验证。输入正确密码后进入补验证页面，需要邮箱验证码及原密码；旧行程数据保留。
- 找回：选择已验证邮箱/已绑定手机，输入验证码和新密码。未注册或未验证的联系方式不能重置密码。验证码申请文案一致，未注册目标也可能收到相同验证码，但无法重置任何账号。
- 个人中心：编辑昵称、简介、常住城市、六类旅行主题、节奏、交通方式和每日预算。资料保存到 PostgreSQL，重新登录仍保留。
- 新行程默认使用个人的主题、节奏和交通偏好，已保存的行程及未提交草稿不被覆盖。每日预算目前只作资料记录，不承诺排程一定符合该预算。
- 账号安全：更换邮箱、绑定/更换/解绑手机、修改密码。敏感操作需当前密码，更换联系方式还需对应验证码；完成后所有设备重新登录。
- 退出登录会撤销服务器会话，复制出来的旧令牌也不再可用；重置或修改密码会撤销全部会话，并让此前验证码失效。

## 接口契约变化

所有路径以 `/api` 开头；错误返回沿用 `{code,message,details?}`。

| 接口                            | 输入与用途                                                                  |
| ------------------------------- | --------------------------------------------------------------------------- |
| POST /auth/code                 | channel: email/phone、target、purpose: register/verify-email/reset-password |
| POST /auth/register             | email、password、displayName、**code（必填）**；返回 LoginResponse          |
| POST /auth/login                | email（兼容原字段，也接受已绑定手机号）、password                           |
| POST /auth/verify-email         | email、password、code                                                       |
| POST /auth/reset-password       | channel、target、code、newPassword                                          |
| POST /auth/logout               | 当前 Bearer token；重复退出仍成功                                           |
| POST /auth/password             | Bearer token；currentPassword、newPassword                                  |
| POST /auth/contact/code         | Bearer token；channel、target                                               |
| POST /auth/contact              | Bearer token；channel、target、code、currentPassword                        |
| POST /auth/contact/remove-phone | Bearer token；currentPassword                                               |
| GET /users/me                   | Bearer token；读取本人资料                                                  |
| PATCH /users/me                 | Bearer token；displayName、bio、homeCity、travelPreferences 中至少一项      |

travelPreferences 包含 themes（history/nature/landmark/art/family/local，可空且不重复）、pace（relaxed/standard/intensive）、transportMode（walking/transit/driving）、dailyBudget（1–100000 的整数或 null）。
不能通过资料接口直接修改邮箱/手机号或自报验证状态。
PublicUser 增加 emailVerified、phone、phoneVerified、bio、homeCity、travelPreferences；不返回密码哈希、验证码摘要、会话清单和内部凭据版本。

验证码 5 分钟失效，同用途同目标 60 秒后才能重发，每个目标每小时最多 5 次、每个来源每小时 20 次。验证码最多尝试 5 次，错误次数会真正提交到数据库。密码登录按账号限频，身份接口按连接来源限频，敏感操作额外按用户限频。
生产代理需谨慎配置：当前不信任任意 X-Forwarded-For；经过同一代理的请求会共享来源 IP 限额。上线时应由可信入口处理客户端 IP，并提供额外的网关限流。
会话保留原来的 Bearer 方式，浏览器使用 sessionStorage；默认七天过期，AUTH_TOKEN_TTL_SECONDS 可调短。尚未引入 refresh token、HttpOnly Cookie 或多因素认证。

## 迁移和测试

新增迁移 `202611250001_auth_profile.js`，增加用户验证/资料字段及 auth_sessions、auth_challenges、auth_rate_limits 表，不改写历史迁移。
升级后原本未带服务器会话编号的 JWT 不再有效，需要重新登录；原账号还需补验邮箱。升级前备份自己的数据库；本次只迁移新分支专用本地库。

```powershell
npm run typecheck
npm run lint
npm test
npm run build
# .env 的 AUTH_TEST_DATABASE_URL 必须指向独立的、名称以 _test 结尾的 PostgreSQL 数据库。
npm run test:auth
```

test:auth 自动迁移专用测试库，测试真实 HTTP 与 PostgreSQL 行为，包括验证码用途、过期、错误锁定、并发消费、跨用户绑定、找回与会话撤销、改密和登录并发、资料隔离。
APP_Test 的真实账号辅助流程同步申请本地验证码；并发/重复注册测试按一次性验证码的新契约拒绝重用。此接口变化需要其他调用方同步传入 code，不能继续使用旧的无验证注册请求。

恢复流程设计参考 [OWASP 找回密码指引](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)。
