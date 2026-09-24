# ClawBox

ClawBox 是一个运行在设备上的配网页与本地控制面板。它先开启 `ClawBox-Setup` 热点供手机配网，拿到家庭 Wi‑Fi 凭据后切换到局域网，通过本机 Web 服务代理本地 `OpenClaw` gateway。

## 当前主链路

1. 设备启动后开启热点 `ClawBox-Setup`
2. 手机连接热点并打开 `http://192.168.4.1/setup`
3. 提交目标 Wi‑Fi 后，设备关闭热点并通过 `NetworkManager + nmcli` 接入局域网
4. 设备通过 DHCP 自动获取 IPv4 地址
5. 优先通过 `http://clawbox-<suffix>.local/` 访问设备
6. 如果客户端不支持 `.local`，改用 OLED 屏幕显示的 IPv4 地址访问

`clawbox.home.arpa` 仅作为可选本地 DNS 别名，不是默认自动发现入口。

## 网络与访问

- 热点模式固定地址：`192.168.4.1`
- 运行模式：DHCP 自动获取地址，不做设备侧静态 IP
- 默认自动发现：Avahi/mDNS，入口为 `http://clawbox-<suffix>.local/`
- IPv4 兜底：OLED 屏幕持续显示当前 IPv4
- 可选本地 DNS：如果交付环境已配置本地 DNS，可额外使用 `clawbox.home.arpa`

## 运行结构

- `src/app/setup/page.tsx`
  提供热点配网页
- `src/components/WifiStep.tsx`
  提交 Wi‑Fi 凭据
- `src/components/DoneStep.tsx`
  在同一 setup 流程中配置 AI、消息通道，并显示系统状态和维护操作
- `src/lib/network.ts`
  调用 `nmcli` 进行扫描、切网、DHCP 等待和热点回退
- `src/lib/system-info.ts`
  汇总系统状态、当前 IPv4、mDNS 主机名和访问入口
- `production-server.js`
  对外监听 Web 服务，并代理本地 `127.0.0.1:18789` 的 OpenClaw gateway

## API 概览

- `POST /setup-api/wifi/scan`
  触发后台 Wi‑Fi 扫描
- `GET /setup-api/wifi/scan`
  轮询扫描结果
- `POST /setup-api/wifi/connect`
  提交 Wi‑Fi 凭据并异步切网；返回 `mdnsHost` 和 `nextUrlHint`
- `GET /setup-api/wifi/status`
  返回稳定字段：`mode`、`connected`、`ssid`、`ipv4`、`gateway`、`hostname`、`mdnsHost`、`accessUrl`
- `GET /setup-api/system/info`
  返回系统状态和当前访问入口
- `GET /setup-api/setup/status`
  返回当前是否已完成配网/完成初始化
- `GET /setup-api/channels/telegram`
  返回 Telegram 是否已配置、是否启用；不会返回 Bot Token
- `POST /setup-api/channels/telegram`
  验证 Bot Token、写入 OpenClaw、重启 gateway，并等待 Telegram 渠道实际上线
- `GET /setup-api/channels/telegram/status`
  通过 OpenClaw live probe 返回 Telegram 运行状态和机器人账号
- `GET|POST /setup-api/channels/telegram/pairing`
  列出并审批首次私聊产生的配对请求，用户无需 SSH 执行 OpenClaw 命令
- `GET|POST /setup-api/channels/feishu`
  验证并保存飞书/Lark 应用凭据，重启 Gateway 后等待渠道实际上线
- `GET /setup-api/channels/feishu/status`
  返回飞书/Lark live probe 状态和机器人名称
- `GET|POST /setup-api/channels/feishu/pairing`
  列出并审批飞书/Lark 首次私聊配对请求
- `GET|POST /setup-api/channels/qqbot`
  验证并保存 QQ 官方机器人凭据，重启 Gateway 后等待通道实际上线
- `GET /setup-api/channels/qqbot/status`
  返回 QQ 官方机器人的 Gateway 连接状态

根路径 `/` 始终进入 `/setup`，不要求账号或管理员登录。主链路保持为“配置 WiFi → 配置 AI → 逐个配置消息通道 → 直接使用”；消息通道属于同一设备向导，不另设登录后的通道主页。

## Telegram 渠道

Telegram 是多渠道接入的第一条参考实现，当前范围为私聊：

1. 先完成 AI provider 配置
2. 在 Telegram 的 `@BotFather` 中执行 `/newbot` 并取得 Bot Token
3. 在 ClawBox 的 Telegram 区粘贴 Token，点击 `Save & Connect`
4. 页面只有在 Bot Token 验证、配置写入、gateway 重启和 live probe 全部成功后才显示完成
5. 打开机器人并发送 `/start`
6. 回到 ClawBox 刷新配对请求，点击 `Approve`
7. 再向机器人发送一条任务，确认能收到 AI 回复

Bot Token 只写入设备上的 OpenClaw 配置文件，接口和页面不会回传明文。当前默认 `dmPolicy=pairing`、`groupPolicy=disabled`，群聊支持后续单独实现。

## 飞书 / Lark 渠道

Lark 是飞书的国际版。中国大陆租户选择飞书，海外租户选择 Lark；OpenClaw 使用同一个通道实现并通过域名区分。该通道使用 WebSocket 长连接，不要求用户部署公网 Webhook：

1. 在飞书开放平台或 Lark Developer Console 创建企业自建应用
2. 启用机器人能力，并在事件订阅中选择长连接模式
3. 发布应用后，将 App ID 和 App Secret 填入 ClawBox
4. 点击 `Save & Connect`，页面通过凭据校验、Gateway 重启和 live probe 后才显示完成
5. 给机器人发送私聊消息，回到 ClawBox 刷新配对请求并点击 `Approve`

App Secret 不会通过接口回传。当前默认 `connectionMode=websocket`、`dmPolicy=pairing`、`groupPolicy=disabled`。

## 本地开发

```bash
bun install
bun run dev
```

生产构建：

```bash
bun run build
node production-server.js
```

测试与检查：

```bash
bun run test
bun run lint
```

## 设备安装

在目标 Linux 设备上执行：

```bash
sudo bash install.sh
```

安装脚本会完成以下事项：

- 安装 `network-manager`、`avahi-daemon`、Node.js、Bun、OLED 依赖
- 保存 Wi‑Fi 接口配置
- 生成稳定设备主机名 `clawbox-<suffix>`
- 安装 systemd 服务
- 安装 Avahi `_http._tcp` 服务广播

安装完成后：

- 先连接 `ClawBox-Setup`
- 打开 `http://192.168.4.1/setup`
- 配网成功后，优先访问 `http://clawbox-<suffix>.local/`
- 如 `.local` 不可解析，则使用 OLED 上显示的 IPv4

## 验收顺序

到手测试请按 [docs/plan-a-verification.md](docs/plan-a-verification.md) 执行。

Telegram 软件与真机验收请按 [docs/telegram-verification.md](docs/telegram-verification.md) 执行。

飞书/Lark 软件与真机验收请按 [docs/feishu-verification.md](docs/feishu-verification.md) 执行。
