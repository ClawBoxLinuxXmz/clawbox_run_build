# ClawBox 多消息通道配置与用户引导工作总结

日期：2026-07-31  
状态：通道功能的软件实现与本地验证完成；尚未暂存、提交或推送 GitHub；等待真实设备与真实平台账号验收。

## 一、本次工作范围

本次工作的核心是在 ClawBox 既有本地初始化页面中，完成多消息通道配置闭环：

```text
进入 /setup -> 完成已有 WiFi/AI 配置 -> 同页配置可选消息通道 -> 直接使用
```

本次保持 ClawBox 本地页面无账号登录，不新增登录后的通道管理主页。Telegram、飞书、QQ、LINE 等官方后台仍要求用户登录对应平台账号来创建机器人或获取凭据，这是第三方平台要求，不属于 ClawBox 登录链路。

本报告只统计通道配置、中英文切换、凭据指引、状态链路和相关测试。当前工作区内已有的 WiFi、热点、reset 现场修复不计入本次通道工程量，也不进入本次 GitHub 候选范围。

## 二、主要交付

| 模块 | 交付内容 |
| --- | --- |
| 通道统一入口 | Telegram、飞书/Lark、QQ、WhatsApp、LINE 均在既有 setup 页面配置，不要求另行登录 ClawBox |
| 中英文切换 | 支持中文、English 无刷新切换，覆盖表单、动态错误、状态反馈、操作按钮和通道指引 |
| 凭据获取指引 | 页面内说明凭据名称、官方入口、控制台操作步骤、安全事项和配置后的验证动作 |
| Telegram | BotFather Token 指引、`getMe` 校验、配置写入、Gateway 重启、live probe、私聊配对查询与批准 |
| 飞书 / Lark | 明确 Lark 是飞书国际版；支持区域选择、App ID/App Secret 校验、WebSocket 长连接、实时状态与配对 |
| QQ 官方机器人 | AppID/AppSecret 校验、官方 Token 接口验证、Gateway 在线状态；明确当前插件不使用 Telegram 式配对 |
| WhatsApp | 插件检查与准备、号码模式、E.164 校验、Linked devices 二维码、扫码轮询、实时状态、配对和解除关联 |
| LINE | Channel access token、Channel secret、公网 HTTPS Webhook、原始字节代理、签名透传、真实入站证据和配对 |
| 状态真实性 | 将“凭据已保存”和“通道真实可用”分开，只有满足平台对应的真实状态条件才显示完成 |
| 安全处理 | 接口不回传 Token/Secret，错误信息脱敏，配置文件权限收紧为 `0600`，二维码和状态接口禁用缓存 |

## 三、通道专项工程量

| 指标 | 数量 | 统计口径 |
| --- | ---: | --- |
| 新增通道适配器 | 5 个、2456 行 | Telegram、飞书/Lark、QQ、WhatsApp、LINE |
| 新增通道 API/Webhook 模块 | 20 个、1598 行 | 19 个 Route Handler，以及 1 个 WhatsApp 响应辅助模块 |
| 新增 i18n/凭据指引基础 | 4 个文件、646 行 | 国际化 Provider、语言选择器、翻译字典和通用凭据指引 |
| 可直接归属的新增实现 | 29 个文件、4700 行 | 上述适配器、服务端模块及 i18n/指引基础 |
| 通道及相关 UI 测试 | 14 个文件、2610 行 | 11 个通道专项测试，加 3 个国际化/指引/UI 契约测试 |
| 通道及相关测试块 | 103 个 | 上述 14 个测试文件中的 `it(...)` 测试块 |
| 保守可归属的新文件总量 | 43 个文件、7310 行 | 仅统计可明确归属通道/i18n 的新增文件，未计共享旧文件改动 |
| 全量自动化测试 | 21 个文件，165/165 通过 | 当前仓库最终软件级验证结果 |

主集成页面 `src/components/DoneStep.tsx` 当前另有新增 2822 行、删除 592 行的变更，其中包含通道 UI、国际化接入和既有 AI/系统面板调整。为避免重复或夸大统计，这部分以及 `SetupWizard`、`layout`、`StatusMessage`、`openclaw-config` 等共享文件改动均未计入上面的 7310 行保守小计。

## 四、主要技术工作

1. 分别核对五个平台的认证方式、配置字段、连接协议、状态定义、配对能力和官方凭据获取步骤。
2. 为配置、状态、配对、二维码、解除关联及 Webhook 建立独立 Route Handler 和平台适配器。
3. 将五个通道的配置、说明、实时状态、错误反馈和下一步操作整合到同一 setup 页面。
4. 建立统一的中英文翻译层，覆盖静态文案、动态错误、变量插值、状态消息和凭据操作说明。
5. 避免凭据通过 GET/POST 响应或错误信息回传，收紧 OpenClaw 配置文件权限。
6. 区分“保存成功”“Gateway 重启成功”“通道实时在线”和“收到真实用户消息”等不同状态证据。
7. 补充路由、适配器、UI 契约、国际化、严格完成条件、签名透传和失败分支测试。
8. 完成桌面、390px 和 320px 移动端页面检查，确保凭据指引展开后没有横向溢出。

## 五、关键技术难点

1. 五个平台的认证、连接和配对机制不同，需要分别适配，同时向前端提供一致的配置与状态语义。
2. WhatsApp 仅在 `linked === true && connected === true` 时完成，并区分未关联、已关联但离线和实时在线。
3. LINE 仅在本地监听运行、Token 探测成功且收到真实入站 Webhook 后完成；时间戳 `0` 不会被误判为入站证据。
4. LINE Webhook 代理保持原始请求字节和 `X-Line-Signature` 不变，避免代理层重编码破坏签名校验。
5. QQ 当前插件没有 Telegram 式 pairing，状态也不能只依据“配置已存在”；需要结合官方验密和 Gateway WebSocket 状态。
6. 保存成功但 Gateway 重启或上线失败时保留 `saved: true` 语义，同时返回可诊断错误，避免用户反复覆盖有效凭据。
7. 在不引入 ClawBox 登录和独立后台的前提下，将多通道配置、实时状态和操作指引整合进既有设备向导。

## 六、质量验证

- 全量测试：21 个测试文件，165/165 通过。
- 通道及相关 UI：14 个测试文件，103 个测试块。
- TypeScript 类型检查：通过。
- 生产构建：通过。
- 相关文件定向 ESLint：0 个错误。
- `DoneStep.tsx` 保留 3 个既有 unused warning。
- 全仓 lint 保留 2 个既有基线错误：`production-server.js` 使用 CommonJS `require`，`src/app/[...gateway]/route.ts` 存在显式 `any`；均不属于本次通道实现引入的问题。
- 页面检查覆盖桌面、390px 和 320px 移动端宽度，未发现横向溢出。

自动化测试覆盖凭据格式校验、官方接口拒绝、敏感字段不回传、配置合并、Gateway 重启失败、状态解析、严格完成条件、二维码生命周期、配对审批、LINE Webhook 字节透传、动态国际化和无登录通道流程。

## 七、真实验收边界

当前完成的是代码实现、自动化测试、类型检查、生产构建和未连接状态页面预览。现有截图使用无真实凭据的模拟预览，不代表平台真机联调结果，也不能作为“通道已连接”的验收证明。

正式交付前仍需逐项验收：

- Telegram：真实 Bot Token、私聊配对、消息收发和 AI 回复。
- 飞书/Lark：已发布应用、WebSocket 事件、用户配对和消息回复。
- QQ：机器人审核及可见范围、真实 Gateway 连接和私聊回复。
- WhatsApp：手机扫码、持续在线、断线恢复、配对及解除关联。
- LINE：公网 HTTPS 可达性、平台 Verify、真实 Webhook、签名链路、配对及回复。
- 通用项：设备重启后的配置持久化、Gateway 自动恢复和敏感信息检查。

## 八、GitHub 候选范围

当前本地 `main` 与远端 `clawbox-linux/main` 没有共同祖先，且目录结构和技术栈不同，因此以下文件不能从当前分支直接 push。发布时必须从最新远端 `main` 新建分支，再按远端现有结构移植和合并。

### 通道核心候选

```text
src/app/line/webhook/route.ts
src/app/setup-api/channels/**
src/lib/channels/**
src/lib/openclaw-config.ts
src/lib/i18n.ts
src/components/CredentialGuide.tsx
src/components/I18nProvider.tsx
src/components/LanguageSelector.tsx
src/app/layout.tsx
src/components/ProgressBar.tsx
src/components/StatusMessage.tsx
src/tests/credential-guide-ui.test.ts
src/tests/i18n.test.ts
src/tests/feishu-channel.test.ts
src/tests/feishu-routes.test.ts
src/tests/line-channel.test.ts
src/tests/line-routes.test.ts
src/tests/line-webhook-route.test.ts
src/tests/qqbot-channel.test.ts
src/tests/qqbot-routes.test.ts
src/tests/telegram-channel.test.ts
src/tests/telegram-routes.test.ts
src/tests/whatsapp-channel.test.ts
src/tests/whatsapp-routes.test.ts
```

### 必须按代码块合并的共享页面

```text
src/components/DoneStep.tsx
src/components/SetupWizard.tsx
src/components/WifiStep.tsx
src/app/setup/wifi/page.tsx
src/tests/setup-flow-ui.test.ts
```

这些文件同时包含远端既有 UI 或本地 WiFi 相关改动，只移植通道、中英文和凭据指引部分，不能整文件覆盖。

### 通道文档候选

```text
README.md
docs/telegram-verification.md
docs/feishu-verification.md
docs/qqbot-verification.md
```

`README.md` 需要先补齐 WhatsApp、LINE 的接口和验收说明，并链接 QQ 验收文档。

### 本次明确排除

```text
install.sh
scripts/start-ap.sh
scripts/stop-ap.sh
src/lib/network.ts
src/lib/setup-status.ts
src/lib/setup-flow.ts
src/app/setup-api/wifi/connect/route.ts
src/app/setup-api/setup/reset/route.ts
src/tests/wifi-connect-route.test.ts
src/tests/setup-flow-routes.test.ts
src/tests/setup-reset-route.test.ts
next.config.ts
src/app/route.ts
src/tests/root-route.test.ts
src/components/CredentialsStep.tsx
CLAUDE.md
docs/clawbox-2026-05-14-live-fix-log.md
docs/clawbox-现场修复补充说明-2026-05-15.md
docs/clawbox-现场修复记录-中文版.md
docs/work-summary-channel-setup-2026-07-31.md
```

发布前还需将通道测试中的个人化或现场化夹具替换为 `Test User`、`Example-WiFi`、`192.0.2.x`、`clawbox-test.local`、`@example_bot` 等中性示例。本次扫描未发现真实 Token、Secret、私钥或 `.env` 凭据。

本总结用于内部工作量说明和发布决策，默认不加入 GitHub 推送清单。
