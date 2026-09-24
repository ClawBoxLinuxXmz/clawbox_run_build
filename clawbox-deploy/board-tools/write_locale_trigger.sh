#!/bin/bash
# 验证 locale 切换 → 守护进程语言变化
cat > /home/clawbox/clawbox/data/locale.json <<'EOF'
{"locale":"en","updated_at":1787889400000}
EOF
echo "locale.json written:"
cat /home/clawbox/clawbox/data/locale.json
echo
sleep 6
echo "--- 守护进程日志 (locale/语言相关) ---"
grep -iE 'locale|语言|trigger' /var/log/clawbox-peripheral.log | tail -8