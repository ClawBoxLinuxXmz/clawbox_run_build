#!/usr/bin/env bash
# =================================================================
# ClawBox 前端/网关 systemd 服务安装脚本(设备端, 幂等)
#
# 用法: sudo bash install_services.sh [NODE_BIN]
#        NODE_BIN 默认 /opt/node22/bin/node(新设备统一 node22)
#
# 自动完成(2026-08-10 新设备部署踩坑后固化):
#   1. 创建 systemd ReadWritePaths 需要的目录(.bun/.npm-global/.npm/.openclaw)
#      —— 否则 clawbox-setup 报 226/NAMESPACE 起不来
#   2. 安装 clawbox-setup / clawbox-gateway / clawbox-ap 三个 service
#      (clawbox-setup 的 ExecStart 自动对齐 NODE_BIN)
#   3. 放置 production-server.cjs 到前端根
#   4. 建 data/network.env(不存在才建)
#   5. chmod AP 脚本
# =================================================================
set -euo pipefail

[ "$EUID" -ne 0 ] && { echo "请以 root 运行: sudo bash install_services.sh"; exit 1; }

NODE_BIN="${1:-/opt/node22/bin/node}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "NODE_BIN = $NODE_BIN"

echo ""
echo "=== 1. 确保 systemd ReadWritePaths 目录存在(防 226/NAMESPACE) ==="
for d in /home/clawbox/.bun /home/clawbox/.npm-global /home/clawbox/.npm /home/clawbox/.openclaw; do
  mkdir -p "$d"
  chown clawbox:clawbox "$d"
  echo "  ✅ $d"
done

echo ""
echo "=== 2. 安装 systemd 服务 ==="
cp -f "$SCRIPT_DIR/clawbox-setup.service" \
      "$SCRIPT_DIR/clawbox-gateway.service" \
      "$SCRIPT_DIR/clawbox-ap.service" /etc/systemd/system/
# 对齐 ExecStart 的 node 路径
sed -i "s|ExecStart=.*node production-server.cjs|ExecStart=$NODE_BIN production-server.cjs|" \
    /etc/systemd/system/clawbox-setup.service
systemctl daemon-reload
echo "  ✅ 3 个 service 已安装(ExecStart node=$NODE_BIN)"

echo ""
echo "=== 3. production-server.cjs → 前端根 ==="
if [ -f "$SCRIPT_DIR/production-server.cjs" ]; then
  cp -f "$SCRIPT_DIR/production-server.cjs" /home/clawbox/clawbox/
  chown clawbox:clawbox /home/clawbox/clawbox/production-server.cjs
  echo "  ✅ 已放置"
else
  echo "  ⚠️ 无 production-server.cjs, 跳过(请确认前端根已有)"
fi

echo ""
echo "=== 4. data/network.env ==="
mkdir -p /home/clawbox/clawbox/data
if [ ! -f /home/clawbox/clawbox/data/network.env ]; then
  cat > /home/clawbox/clawbox/data/network.env <<'EOF'
NETWORK_INTERFACE=wlan0
EOF
  chown clawbox:clawbox /home/clawbox/clawbox/data/network.env
  echo "  ✅ network.env 已建"
else
  echo "  ℹ️ 已存在, 跳过"
fi

echo ""
echo "=== 5. AP 脚本可执行 ==="
chmod +x /home/clawbox/clawbox/scripts/*.sh 2>/dev/null || true
echo "  ✅"

echo ""
echo "=== 6. NetworkManager polkit 授权(前端连 WiFi 必需) ==="
# 前端以 clawbox 用户调 nmcli 连 WiFi, 需 polkit 放行, 否则 Insufficient privileges
# (2026-08-10 新设备部署实测: 仅加 netdev 组在 NM 1.42.4 上仍可能被拒,
#  polkit 显式规则是确定性方案)
mkdir -p /etc/polkit-1/rules.d
cat > /etc/polkit-1/rules.d/10-clawbox-network.rules <<'POLKIT_EOF'
polkit.addRule(function(action, subject) {
  if (action.id.indexOf("org.freedesktop.NetworkManager.") === 0 &&
      subject.user === "clawbox") {
    return polkit.Result.YES;
  }
});
POLKIT_EOF
echo "  ✅ polkit 规则已写(10-clawbox-network.rules)"
# 附加组(与旧设备一致; netdev 为 NM 权限兜底)
usermod -aG dialout,sudo,audio,video,netdev,i2c clawbox 2>/dev/null || true
echo "  ✅ clawbox 附加组已补(dialout/sudo/audio/video/netdev/i2c)"

# 注意: 需重启 clawbox-setup 让组/polkit 生效

echo ""
echo "✅ install_services.sh 完成"
echo "下一步(按需): systemctl enable --now clawbox-setup"
echo "  clawbox-gateway 需先装好 openclaw 再 enable"
