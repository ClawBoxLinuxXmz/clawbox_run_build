# ClawBox 现场修复记录（中文版）

更新时间：2026-05-15 晚
目标设备：`192.168.31.55`
项目路径：`D:\workspace\clawbox-main\clawbox-main`

---

## 一、本次接手后已实现的核心结果

### 1) 微信通道链路已打通（核心目标）
- 将配置键从历史口径 `channels.wechat` 对齐到实际插件口径 `channels.openclaw-weixin`。
- 新增并接入真实登录状态接口：
  - `GET /setup-api/wechat/login-status`
- 前端 WeChat 完成态改为依据真实连接状态 `connected`，不再只看 `enabled`。
- 真实设备上已确认账号凭证落盘：
  - `/home/clawbox/.openclaw/openclaw-weixin/accounts/76b339cdaae6-im-bot.json`
- 真实设备上已确认状态：
  - `{"connected": true, "accountIds": ["76b339cdaae6-im-bot"]}`

### 2) 二维码登录流程已做稳健化
- 修复了“出码慢、偶发超时、状态不一致”的问题：
  - 增强超时窗口与诊断输出；
  - 改造为更稳健的登录过程（避免过早中断）；
  - 支持 pending 过程提示。

### 3) 运行稳定性问题已修复
- 修复远程维护过程中 AP 导致掉线的问题：
  - 维护时不把 AP 作为默认重启项；
  - 修复脚本执行位与属主（`chmod/chown`）避免 systemd 203/EXEC。
- 修复 setup 服务重启循环：
  - 根因：`.next` 下出现零字节 manifest，触发 `Unexpected end of JSON input`；
  - 通过完整重建与运行入口修复恢复服务。

### 4) 回滚与审计能力已建立
- 本地 Git 已初始化并建立多次检查点提交，便于回滚与审计。
- 现场修复日志已持续更新。

---

## 二、本次主要改动清单

### 后端改动
- `src/lib/openclaw-config.ts`
  - 对齐 `openclaw-weixin`；
  - 增加登录状态读取逻辑；
  - 过滤 `.sync/.context-tokens` 文件，避免误判账号列表。
- `src/app/setup-api/wechat/qrcode/route.ts`
  - 二维码登录流程增强（更稳健、可诊断）。
- `src/app/setup-api/wechat/configure/route.ts`
  - 配置保存后返回最新状态信息。
- `src/app/setup-api/wechat/login-status/route.ts`（新增）
  - 提供真实连接状态接口。

### 前端改动
- `src/components/DoneStep.tsx`
  - WeChat 状态改为按真实 `connected` 判定；
  - 接入 `login-status` 轮询能力。

### 运行入口修复
- `production-server.js`
  - 增强生产启动稳定性，减少因构建产物异常导致的启动循环。

---

## 三、已执行的关键操作（概述）

1. 本地代码盘点与关键路由核对。
2. 树莓派服务状态与接口联调。
3. 识别并修复微信键名分叉与二维码流程分叉。
4. 多轮部署与真机回归。
5. 处理 AP/网络切换导致的 SSH 掉线问题。
6. 处理 setup 服务异常重启（零字节构建产物）。
7. 最终确认微信账号文件落盘、状态接口 connected。

---

## 四、Git 检查点（节选）

- `7a995c0` `chore: bootstrap local git baseline for clawbox takeover (2026-05-15)`
- `e90b237` `chore: add git line-ending guard and rollback notes`
- `9440284` `docs: log 2026-05-15 network-drop mitigation and operator runbook`
- `ef05f29` `fix(wechat): align channel key with openclaw-weixin and add login status flow`
- `d731a70` `fix(runtime): harden setup server start and ignore weixin sync/context files`

---

## 五、当前状态结论

- 微信通道：**已打通（connected=true，账号凭证已落盘）**。
- setup / gateway / oled：已恢复到可运行状态（期间经历过网络与重启抖动，已做修复）。
- 维护策略：已形成可复用的低风险流程（避免 AP 误触发、先修权限再重启）。

---

## 六、后续建议（精简）

1. 将“非 AP 维护重启流程”固化成脚本，减少人工误操作。
2. 增加构建产物健康检查（防零字节文件）后再切服务。
3. 将微信通道回环测试纳入部署后验收清单（自动化）。
