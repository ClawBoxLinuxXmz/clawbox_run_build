#!/bin/bash
# 设备端验证：locale 同步 + 二维码触发 → 墨水屏联动
set -x

# 1. locale 同步
curl -s -X POST http://127.0.0.1/setup-api/locale \
  -H 'Content-Type: application/json' \
  -d '{"locale":"zh-CN"}'
echo
echo "--- locale.json ---"
cat /home/clawbox/clawbox/data/locale.json 2>/dev/null
echo

# 2. 二维码触发 (模拟前端生成微信二维码)
curl -s -X POST http://127.0.0.1/setup-api/wechat/qrcode \
  -H 'Content-Type: application/json' \
  -d '{}'
echo
echo "--- chat-qr.json ---"
cat /home/clawbox/clawbox/data/chat-qr.json 2>/dev/null
echo

# 3. 等守护进程检测
sleep 4
echo "--- 守护进程日志尾部 ---"
tail -8 /var/log/clawbox-peripheral.log