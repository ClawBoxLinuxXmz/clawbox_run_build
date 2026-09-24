#!/usr/bin/env bash
# 核桃派2B ClawBox 安装脚本
set -euo pipefail

# 检查是否为root用户
if [ "$(id -u)" -ne 0 ]; then
  echo "Error: Please run this script as root (sudo)" >&2
  exit 1
fi

# systemd clawbox-root-update@*.service 单步更新（无 JetPack / 无独立 dnsmasq）
run_update_step() {
  local step="${1:-}"
  case "$step" in
    apt_update)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get upgrade -y -qq
      ;;
    openclaw_install)
      if id -u clawbox &>/dev/null; then
        sudo -u clawbox env HOME=/home/clawbox npm install -g openclaw@latest --prefix /home/clawbox/.npm-global || true
      fi
      ;;
    chpasswd)
      INPUT_FILE="/home/clawbox/clawbox/data/.chpasswd-input"
      if [ ! -f "$INPUT_FILE" ]; then
        echo "Missing chpasswd input file: $INPUT_FILE" >&2
        exit 1
      fi
      chpasswd < "$INPUT_FILE"
      rm -f "$INPUT_FILE"
      ;;
    reboot)
      echo "[install] reboot: reboot device"
      systemctl reboot
      ;;
    rebuild_reboot)
      echo "[install] rebuild_reboot: rebuild Next.js app and reboot"
      cd /home/clawbox/clawbox
      sudo -u clawbox env HOME=/home/clawbox /home/clawbox/.bun/bin/bun install
      sudo -u clawbox env HOME=/home/clawbox /home/clawbox/.bun/bin/bun run build
      systemctl restart clawbox-setup.service 2>/dev/null || true
      systemctl reboot
      ;;
    *)
      echo "Unknown update step: $step" >&2
      exit 1
      ;;
  esac
}

if [[ "${1:-}" == "--step" ]] && [[ -n "${2:-}" ]]; then
  run_update_step "$2"
  exit 0
fi

# 配置变量
REPO_URL="https://github.com/ID-Robots/clawbox.git"
REPO_BRANCH="${CLAWBOX_BRANCH:-main}"
PROJECT_DIR="/home/clawbox/clawbox"
CLAWBOX_USER="clawbox"
CLAWBOX_HOME="/home/clawbox"
BUN="$CLAWBOX_HOME/.bun/bin/bun"
NPM_PREFIX="$CLAWBOX_HOME/.npm-global"
DEVICE_HOSTNAME_FILE="$PROJECT_DIR/data/device-hostname.env"
HOST_SUFFIX_LENGTH="${CLAWBOX_HOST_SUFFIX_LENGTH:-6}"

# 检测WiFi接口
detect_wifi_interface() {
  local IFACE="${NETWORK_INTERFACE:-}"
  if [ -z "$IFACE" ]; then
    IFACE=$(iw dev 2>/dev/null | awk '/Interface/ {print $2}' | head -1 || echo "wlan0")
  fi
  echo "$IFACE"
}

WIFI_IFACE=$(detect_wifi_interface)

echo "=========================================="
echo "  ClawBox for WalnutPi 2B Installer"
echo "=========================================="
echo ""
echo "WiFi Interface: $WIFI_IFACE"
echo "Project Dir: $PROJECT_DIR"
echo ""

# 步骤1: 创建用户
step_create_user() {
  echo "[1/11] Creating user..."
  if ! id -u "$CLAWBOX_USER" &>/dev/null; then
    useradd -m -s /bin/bash "$CLAWBOX_USER"
    # 添加到必要的组
    for grp in sudo video audio i2c gpio dialout netdev; do
      if getent group "$grp" &>/dev/null; then
        usermod -aG "$grp" "$CLAWBOX_USER" 2>/dev/null || true
      fi
    done
    echo "  User $CLAWBOX_USER created"
  else
    echo "  User $CLAWBOX_USER already exists"
  fi
}

# 步骤2: 安装系统依赖
step_install_deps() {
  echo "[2/11] Installing system dependencies..."
  
  apt-get update -qq
  
  # 基础依赖
  apt-get install -y -qq \
    git curl network-manager avahi-daemon iw i2c-tools \
    python3 python3-pip python3-venv \
    nodejs

  if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is not available after installing nodejs." >&2
    echo "Install a Node.js distribution that includes npm, then re-run install.sh." >&2
    exit 1
  fi
  
  echo "  System dependencies installed"
}

# 步骤3: 配置NetworkManager
step_configure_nm() {
  echo "[3/11] Configuring NetworkManager..."
  
  # 确保NetworkManager正在运行
  systemctl enable NetworkManager
  systemctl start NetworkManager || true
  mkdir -p /etc/NetworkManager/conf.d
  cat >/etc/NetworkManager/conf.d/10-clawbox-managed.conf <<EOF
[main]
plugins=ifupdown,keyfile

[ifupdown]
managed=true
EOF
  rfkill unblock wifi 2>/dev/null || true
  nmcli radio wifi on 2>/dev/null || true
  nmcli device set "$WIFI_IFACE" managed yes 2>/dev/null || true
  ip link set "$WIFI_IFACE" up 2>/dev/null || true
  systemctl restart NetworkManager || true

  echo "  NetworkManager configured"
}

# 步骤4: 克隆或更新项目
step_clone_project() {
  echo "[4/11] Setting up project files..."
  
  if [ ! -d "$PROJECT_DIR/.git" ]; then
    if [ -d "/workspace/clawbox-main" ]; then
      # 如果在开发环境中已有文件，直接复制
      echo "  Copying project from workspace..."
      mkdir -p "$PROJECT_DIR"
      cp -r /workspace/clawbox-main/* "$PROJECT_DIR/"
    elif [ -d "$PROJECT_DIR" ] && [ -n "$(find "$PROJECT_DIR" -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
      echo "  Reusing existing project directory..."
    else
      echo "  Cloning repository..."
      git clone --branch "$REPO_BRANCH" "$REPO_URL" "$PROJECT_DIR"
    fi
  else
    echo "  Updating repository..."
    git -C "$PROJECT_DIR" fetch origin
    git -C "$PROJECT_DIR" checkout "$REPO_BRANCH" 2>/dev/null || true
    git -C "$PROJECT_DIR" merge --ff-only "origin/$REPO_BRANCH" 2>/dev/null || echo "  Warning: Merge failed, keeping local changes"
  fi
  
  # 设置权限
  chown -R "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR"
  chmod +x "$PROJECT_DIR/scripts/"*.sh
  
  echo "  Project files ready"
}

# 步骤5: 保存网络接口配置
step_save_network_config() {
  echo "[5/11] Saving network configuration..."
  
  mkdir -p "$PROJECT_DIR/data"
  echo "NETWORK_INTERFACE=$WIFI_IFACE" > "$PROJECT_DIR/data/network.env"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$PROJECT_DIR/data" "$PROJECT_DIR/data/network.env"
  
  # 同时保存到系统目录
  mkdir -p /etc/clawbox
  cp "$PROJECT_DIR/data/network.env" /etc/clawbox/
  
  echo "  Network configuration saved"
}

step_configure_device_identity() {
  echo "[6/11] Configuring device hostname and mDNS..."

  local hostname
  local mac_suffix
  mac_suffix=$(tr -d ':\n' < "/sys/class/net/$WIFI_IFACE/address" 2>/dev/null | tr '[:upper:]' '[:lower:]' | tail -c $((HOST_SUFFIX_LENGTH + 1)) || true)
  if [ -n "$mac_suffix" ]; then
    hostname="clawbox-${mac_suffix}"
  else
    local machine_suffix
    machine_suffix=$(tr -d '\n' < /etc/machine-id 2>/dev/null | tr '[:upper:]' '[:lower:]' | tail -c $((HOST_SUFFIX_LENGTH + 1)) || true)
    if [ -n "$machine_suffix" ]; then
      hostname="clawbox-${machine_suffix}"
    else
      hostname="clawbox-device"
    fi
  fi

  hostnamectl set-hostname "$hostname"
  if [ -f /etc/hosts ]; then
    if grep -Eq '^127\.0\.1\.1[[:space:]]+' /etc/hosts; then
      sed -i -E "s/^127\\.0\\.1\\.1[[:space:]].*/127.0.1.1 $hostname/" /etc/hosts
    else
      printf '127.0.1.1 %s\n' "$hostname" >> /etc/hosts
    fi
  fi
  printf 'CLAWBOX_DEVICE_HOSTNAME=%s\n' "$hostname" > "$DEVICE_HOSTNAME_FILE"
  chown "$CLAWBOX_USER:$CLAWBOX_USER" "$DEVICE_HOSTNAME_FILE"

  install -D -m 0644 "$PROJECT_DIR/config/clawbox-http.service.xml" /etc/avahi/services/clawbox-http.service
  systemctl enable avahi-daemon
  systemctl restart avahi-daemon || true

  echo "  Device hostname: $hostname"
}

# 步骤6: 安装Bun
step_install_bun() {
  echo "[7/11] Installing Bun..."
  
  if [ ! -x "$BUN" ]; then
    sudo -u "$CLAWBOX_USER" env HOME="$CLAWBOX_HOME" bash -c 'curl -fsSL https://bun.sh/install | bash'
  else
    echo "  Bun already installed"
  fi
  
  echo "  Bun ready"
}

# 步骤7: 构建项目
step_build_project() {
  echo "[8/11] Building project..."
  
  cd "$PROJECT_DIR"
  sudo -u "$CLAWBOX_USER" "$BUN" install
  sudo -u "$CLAWBOX_USER" "$BUN" run build
  
  echo "  Project built successfully"
}

# 步骤8: 安装Python OLED依赖
step_install_oled_deps() {
  echo "[9/11] Installing OLED dependencies..."
  
  # 创建Python虚拟环境
  sudo -u "$CLAWBOX_USER" python3 -m venv "$CLAWBOX_HOME/oled-env"
  
  # 安装依赖
  sudo -u "$CLAWBOX_USER" "$CLAWBOX_HOME/oled-env/bin/pip" install --upgrade pip
  sudo -u "$CLAWBOX_USER" "$CLAWBOX_HOME/oled-env/bin/pip" install luma.oled luma.core netifaces || true
  
  echo "  OLED dependencies installed"
}

# 步骤9: 安装systemd服务
step_install_services() {
  echo "[10/11] Installing system services..."
  
  # 复制服务文件
  cp "$PROJECT_DIR/config/clawbox-ap.service" /etc/systemd/system/
  cp "$PROJECT_DIR/config/clawbox-setup.service" /etc/systemd/system/
  cp "$PROJECT_DIR/config/clawbox-oled.service" /etc/systemd/system/
  if [ -f "$PROJECT_DIR/config/clawbox-gateway.service" ]; then
    cp "$PROJECT_DIR/config/clawbox-gateway.service" /etc/systemd/system/
  fi
  if [ -f "$PROJECT_DIR/config/clawbox-root-update@.service" ]; then
    cp "$PROJECT_DIR/config/clawbox-root-update@.service" /etc/systemd/system/
  fi

  # 安装 polkit 规则，允许 clawbox 用户控制 NetworkManager 和特定 systemd 单元
  if [ -f "$PROJECT_DIR/config/49-clawbox-updates.rules" ]; then
    install -D -m 0644 \
      "$PROJECT_DIR/config/49-clawbox-updates.rules" \
      /etc/polkit-1/rules.d/49-clawbox-updates.rules
  fi
  if [ -f "$PROJECT_DIR/config/49-clawbox-updates.pkla" ] && [ -d /etc/polkit-1/localauthority/50-local.d ]; then
    install -D -m 0644 \
      "$PROJECT_DIR/config/49-clawbox-updates.pkla" \
      /etc/polkit-1/localauthority/50-local.d/49-clawbox-updates.pkla
  fi
  
  # 重新加载systemd
  systemctl daemon-reload
  
  # 启用服务
  systemctl enable clawbox-ap.service
  systemctl enable clawbox-setup.service
  systemctl enable clawbox-oled.service
  if [ -f "/etc/systemd/system/clawbox-gateway.service" ]; then
    systemctl enable clawbox-gateway.service || true
  fi
  
  echo "  System services installed"
}

# 步骤10: 启动服务
step_start_services() {
  echo "[11/11] Starting services..."
  
  # 先启动热点
  systemctl restart clawbox-ap.service
  
  # 启动设置界面
  systemctl restart clawbox-setup.service
  
  # 启动OpenClaw网关（如果已安装）
  systemctl restart clawbox-gateway.service || true

  # 启动OLED显示
  systemctl restart clawbox-oled.service || true
  
  echo "  Services started"
}

# 主函数
main() {
  step_create_user
  step_install_deps
  step_configure_nm
  step_clone_project
  step_save_network_config
  step_configure_device_identity
  step_install_bun
  step_build_project
  step_install_oled_deps
  step_install_services
  step_start_services
  
  echo ""
  echo "=========================================="
  echo "  Installation Complete!"
  echo "=========================================="
  echo ""
  echo "  WiFi Hotspot: ClawBox-Setup"
  echo "  Setup URL: http://192.168.4.1/setup"
  echo ""
  echo "  After setup, reconnect to the same WiFi and open:"
  echo "    http://$(hostnamectl --static).local/"
  echo "  If .local does not resolve on your device, use the IP shown on the OLED display."
  echo ""
  echo "  Service status commands:"
  echo "    systemctl status clawbox-ap"
  echo "    systemctl status clawbox-setup"
  echo "    systemctl status clawbox-oled"
  echo ""
}

# 执行主函数
main
