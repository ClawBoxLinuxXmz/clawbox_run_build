# 飞书 / Lark 渠道验收

## 验收范围

`ClawBox Web -> App ID/Secret 校验 -> OpenClaw 配置 -> Gateway 重启 -> live probe -> 首次私聊配对审批 -> 消息收发`

当前使用 OpenClaw 内置 Feishu 扩展的 WebSocket 长连接模式，不需要公网 Webhook；只开放私聊，群聊默认禁用。

## 准备测试应用

1. 国内飞书打开 `https://open.feishu.cn/app`，Lark 打开 `https://open.larksuite.com/app`
2. 创建企业自建应用并启用机器人能力
3. 在事件订阅中选择“使用长连接接收事件”
4. 添加机器人收发消息所需权限并发布应用
5. 在凭证页取得 App ID 和 App Secret

App Secret 只能输入设备 Web 页面，不得写入测试记录、截图、Git 提交或聊天消息。

## Web 验收步骤

1. 完成 WiFi 和 AI provider 配置
2. 打开 `Feishu / Lark`，选择正确平台
3. 输入 App ID 和 App Secret，点击 `Save & Connect`
4. 确认页面显示 `Feishu is online as <bot name>`
5. 在飞书/Lark 中给机器人发送一条私聊消息
6. 回到 ClawBox 刷新配对请求，点击 `Approve`
7. 再发送一条普通消息，确认机器人返回 AI 回复

## 失败分支

- App ID/Secret 格式错误或平台拒绝：`400`，不得写入配置
- 开放平台不可达：`502`，不得写入配置
- AI 未配置：`409`
- Gateway 重启失败或 live probe 未通过：`502` 且 `saved=true`，不能显示在线
- 渠道未启用：配对接口返回 `409`

## 树莓派侧必须复测

1. 目标 OpenClaw 版本包含 Feishu 扩展并支持 WebSocket 模式
2. 树莓派网络可访问对应开放平台和长连接服务
3. 重启设备后渠道自动恢复在线
4. 断网恢复后长连接自动重建
5. 实际消息能触发 AI provider 并返回结果

## 辅助诊断命令

```bash
sudo -u clawbox env HOME=/home/clawbox \
  /home/clawbox/.npm-global/bin/openclaw channels status \
  --probe --timeout 8000 --json

sudo -u clawbox env HOME=/home/clawbox \
  /home/clawbox/.npm-global/bin/openclaw pairing list feishu --json

sudo journalctl -u clawbox-gateway.service -n 200 --no-pager
```

提交日志前必须脱敏 App Secret 和访问令牌。
