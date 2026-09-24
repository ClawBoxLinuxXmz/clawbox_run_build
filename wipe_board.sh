#!/bin/bash
# 删板脚本：停止服务 + 清空部署目录（保留 clawbox 用户和系统依赖）
set -x

# 1. 停止所有 ClawBox 服务
systemctl stop clawbox-setup clawbox-gateway clawbox-ap 2>/dev/null || true
systemctl disable clawbox-setup clawbox-gateway clawbox-ap 2>/dev/null || true

# 2. 停止守护进程（supervisor 会拉起，先杀 supervisor 再杀 daemon）
pkill -f supervisor.sh 2>/dev/null || true
sleep 1
pkill -f peripheral_daemon.py 2>/dev/null || true
sleep 2

# 3. 清空部署目录
rm -rf /home/clawbox/clawbox-deploy
rm -rf /home/clawbox/clawbox
rm -rf /tmp/frontend-src
rm -f /home/clawbox/deploy_all.sh
rm -f /home/clawbox/restart_daemon.sh

# 4. 清理 systemd 服务文件（保留 install_services.sh 会重新装）
rm -f /etc/systemd/system/clawbox-setup.service
rm -f /etc/systemd/system/clawbox-gateway.service
rm -f /etc/systemd/system/clawbox-ap.service
systemctl daemon-reload 2>/dev/null || true

# 5. 清理 rc.local 中的守护进程启动行（保留其他行）
sed -i '/clawbox-peripheral/d' /etc/rc.local 2>/dev/null || true

echo "=== 删板完成 ==="
echo "clawbox-deploy: $(ls /home/clawbox/clawbox-deploy 2>&1)"
echo "clawbox: $(ls /home/clawbox/clawbox 2>&1)"
echo "frontend-src: $(ls /tmp/frontend-src 2>&1)"
echo "deploy_all.sh: $(ls /home/clawbox/deploy_all.sh 2>&1)"
echo "clawbox 用户: $(id clawbox 2>&1)"
echo "node: $(/opt/node22/bin/node -v 2>&1 || echo 无)"