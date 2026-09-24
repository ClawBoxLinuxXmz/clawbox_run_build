#!/bin/bash
# 写一个合法的 chat-qr.json 并观察守护进程反应
cat > /home/clawbox/clawbox/data/chat-qr.json <<'EOF'
{"platform":"wechat","qr_type":"url","qr_url":"https://liteapp.weixin.qq.com/test","updated_at":1787889300000}
EOF
echo "written:"
cat /home/clawbox/clawbox/data/chat-qr.json
echo
sleep 6
echo "--- 守护进程日志 ---"
tail -12 /var/log/clawbox-peripheral.log