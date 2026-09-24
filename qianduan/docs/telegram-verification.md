# Telegram 渠道验收

## 验收范围

本实现覆盖以下链路：

`ClawBox Web -> Bot Token 校验 -> OpenClaw 配置 -> Gateway 重启 -> live probe -> 首次私聊配对审批 -> Telegram 消息收发`

Telegram 为 OpenClaw 内置渠道，不需要额外安装插件。当前只开放私聊，群聊默认禁用。

## 准备测试机器人

1. 在 Telegram 中确认账号为官方 `@BotFather`
2. 发送 `/newbot`
3. 按提示设置机器人名称和以 `bot` 结尾的用户名
4. 保存 BotFather 返回的 Bot Token

Bot Token 只能输入设备 Web 页面，不得写进测试记录、截图、Git 提交或聊天消息。

## Web 验收步骤

1. 完成 WiFi 和 AI provider 配置
2. 打开 ClawBox 管理页中的 `Telegram`
3. 确认 AI 未配置时，Telegram 开关、Token 输入框和保存按钮不可用
4. 粘贴 Bot Token，保持 `Enable Telegram` 开启
5. 点击 `Save & Connect`
6. 确认页面显示 `Telegram is online as @<bot_username>`
7. 点击机器人链接，在 Telegram 中发送 `/start`
8. 返回 ClawBox，点击 `Refresh pairing requests`
9. 确认列表显示当前 Telegram 用户，点击 `Approve`
10. 再发送一条普通消息，确认机器人返回 AI 回复

## 失败分支

- Token 格式错误：接口返回 `400`，不得写入配置
- Token 被 Telegram 拒绝：接口返回 `400`，不得写入配置
- 无法访问 `api.telegram.org`：接口返回 `502`，提示检查网络或代理
- Gateway 重启失败：接口返回 `502` 和 `saved=true`，不能显示渠道在线
- live probe 未通过：接口返回 `502` 和 `saved=true`，不能显示渠道在线
- AI 未配置：配置接口返回 `409`
- Telegram 未启用：配对接口返回 `409`
- 配对码失效：审批失败并保留可重试提示

## 软件侧已覆盖

- Bot Token 格式校验和 Telegram `getMe` 身份验证
- `channels.telegram` 配置结构
- 配置文件原子写入及 `0600` 权限
- Token 不出现在 GET/POST 响应中
- Gateway 重启失败与渠道未上线分支
- `openclaw channels status --probe --timeout 8000 --json`
- `openclaw pairing list telegram --json`
- `openclaw pairing approve telegram <code> --notify`
- 桌面和 390px 手机页面无横向溢出

## 树莓派侧必须复测

1. ARM64 环境中的 OpenClaw 版本支持上述 CLI 参数
2. `clawbox-setup.service` 有权限重启 `clawbox-gateway.service`
3. 树莓派网络可访问 `api.telegram.org`
4. 重启设备后 Telegram 自动恢复在线
5. 断网并恢复后 Telegram polling 能自动恢复
6. 用户完成配对后，授权状态在设备重启后仍保留
7. 实际消息能触发已配置的 AI provider 并返回结果

## 辅助诊断命令

```bash
sudo -u clawbox env HOME=/home/clawbox \
  /home/clawbox/.npm-global/bin/openclaw channels status \
  --probe --timeout 8000 --json

sudo -u clawbox env HOME=/home/clawbox \
  /home/clawbox/.npm-global/bin/openclaw pairing list telegram --json

sudo journalctl -u clawbox-gateway.service -n 200 --no-pager
```

诊断输出中如意外出现 Bot Token，提交日志前必须先脱敏。
