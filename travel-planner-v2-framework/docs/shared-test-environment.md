# 团队共享测试环境

## 使用

在线入口：<https://124.220.224.77>。

需要调试前端时，从仓库根目录进入工程：

```bash
git clone --single-branch --branch feature/auth-profile https://github.com/zhangxuezheng-zxz/Travel-Planning-Assistant.git
cd Travel-Planning-Assistant/travel-planner-v2-framework
npm ci
npm run dev:shared
```

打开 <http://localhost:5173>。测试者只需 Node.js 22.12 以上和 npm，推荐 Node.js 24；无需本地数据库、SMTP 授权码和服务器 SSH 密码。前端的 /api 请求由 Vite 代理到公共 HTTPS 接口。需要其他端口时使用 `npm run dev:shared -- --port 5176`。

注册时填写自己的真实邮箱，点击获取验证码，在邮件中查收六位验证码并完成注册。验证码五分钟内有效，同用途六十秒后可重发。每个目标每小时最多五次，来源也有限频。登录使用邮箱和密码，忘记密码使用已验证邮箱找回。真实短信暂不可用。

这是团队共用的测试数据库；每个账号通过身份校验访问自己的资料和行程。原本在个人电脑独立数据库里创建的账号不会自动迁入。新环境已有北京十八个景点和原有杭州演示目录。

## 环境选择

| 命令               | 后端与数据                                         |
| ------------------ | -------------------------------------------------- |
| npm run dev:shared | 公网共享测试后端，只启动本地前端                   |
| npm run dev:web    | 由个人 .env 的 API_PROXY_TARGET/PORT 决定          |
| npm run dev        | 启动个人本地 API 和前端，需要自己的数据库配置      |
| npm run test:auth  | 专用 AUTH_TEST_DATABASE_URL，库名必须以 _test 结尾 |

共享入口独立于个人 .env 中的本地 API_PROXY_TARGET。只有 SHARED_API_PROXY_TARGET 会覆盖共享接口默认值，而且必须为不带路径、账号密码的 HTTPS origin。这个地址是公开配置，里面不应放任何密钥。

## 服务器布局

- API：systemd 的 travel-auth-profile.service，仅监听 127.0.0.1:3000。
- PostgreSQL 17：数据库 travel_auth_profile，应用角色 travel_auth_app，端口仅本机可达。
- 发布目录：/home/ubuntu/travel-auth-profile/releases/，current 指向当前发布。
- 私有环境文件：/home/ubuntu/travel-auth-profile/shared/.env，权限 600。
- 私有媒体：/home/ubuntu/travel-auth-profile/shared/media，跨发布保留。
- 网页：/var/www/travel-auth-profile/current，由 Nginx 提供。
- 公网：Nginx 的 80/443，HTTP 自动转向 HTTPS；/api 转发到本机 API。

邮件配置、数据库密码、JWT 签名密钥不进入发布包、网页和 GitHub。服务器使用独立生成的数据库凭据及稳定签名密钥。用户数据保存在 PostgreSQL 的系统数据目录中，不在应用发布目录里。

TRUST_PROXY=loopback 仅在服务器由本机 Nginx 代理时启用。Nginx 必须用实际连接地址替换 X-Forwarded-For，防止伪造来源 IP。独立本地开发默认关闭代理信任。

## HTTPS 与维护

使用 Let's Encrypt 的 shortlived IP 证书，不需要额外域名。证书寿命约六天，通过 travel-auth-cert-renew.timer 每天检查四次，成功续期后校验并重载 Nginx。

```bash
sudo systemctl status travel-auth-profile nginx postgresql
sudo journalctl -u travel-auth-profile -n 100 --no-pager
sudo systemctl list-timers travel-auth-cert-renew.timer
sudo journalctl -u travel-auth-cert-renew.service --no-pager
sudo /opt/travel-auth-certbot/bin/certbot renew --dry-run --cert-name travel-auth-profile-ip
```

Certbot 安装在独立环境 /opt/travel-auth-certbot，当前版本 5.10.0。升级它时需要同时检查支持的 Python 版本，不能盲目替换当前可用环境。
IP 证书签发与续期方法参考 [Let's Encrypt 官方说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)。

## 发布更新

在开发电脑完成测试后：

```bash
npm run package:server
```

发布包为 apps/api/.data/server-release.tar.gz，同时生成 SHA256 文件。打包采用白名单，只包含构建产物、运行所需包描述、迁移、景点目录和 deploy 模板，不包含 .env、.data、node_modules。

将发布包通过可信 SSH 通道传到服务器的 /home/ubuntu/travel-auth-profile/server-release.tar.gz，再运行 deploy/activate.sh，传入新的发布目录名及校验值。脚本核验 SHA256、安装锁文件生产依赖、创建专用数据库（仅首次）、运行迁移、初始化空库目录并启动服务。已有用户和非空景点目录不会被重建。
Nginx 与续期服务模板位于 deploy/。初次配置需要先完成正式证书签发，再启用 nginx.conf，不能把测试证书当作正式证书使用。

正式升级迁移前应使用数据库的备份和恢复流程；回退代码目录不会自动回退数据库结构。本环境没有建立异机备份，不把单机磁盘持久化等同于灾难恢复。
