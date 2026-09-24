#!/bin/bash
# 删板重装后联动验证
echo "=== 1. locale 同步 ==="
curl -s -X POST http://127.0.0.1/setup-api/locale \
  -H 'Content-Type: application/json' \
  -d '{"locale":"zh-CN"}'
echo
cat /home/clawbox/clawbox/data/locale.json 2>/dev/null
echo

echo "=== 2. 二维码触发 ==="
cat > /home/clawbox/clawbox/data/chat-qr.json <<'EOF'
{"platform":"wechat","qr_type":"url","qr_url":"https://liteapp.weixin.qq.com/test","updated_at":1787890000000}
EOF
sleep 6
grep -E 'QR触发器|页面2' /var/log/clawbox-peripheral.log | tail -3

echo "=== 3. 语言切换 ==="
cat > /home/clawbox/clawbox/data/locale.json <<'EOF'
{"locale":"en","updated_at":1787890001000}
EOF
sleep 6
grep -E '语言切换' /var/log/clawbox-peripheral.log | tail -2