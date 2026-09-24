#!/bin/bash
# =================================================================
# ClawBox 外设守护进程 —— 一键部署脚本（含墨水屏驱动）
# 
# 用法（在核桃派上）:
#   1. scp -r clawbox-deploy root@<IP>:/home/clawbox/
#   2. cd /home/clawbox/clawbox-deploy/clawbox-peripheral && sudo bash install.sh
#
# 自动完成（一步装完驱动+守护进程）:
#   启用 SPI(墨水屏) → 安装依赖 → 停止旧进程 → 设置开机自启 → 启动服务
#   （epd-driver/ 墨水屏驱动已并入本目录；直接在当前目录运行）
# =================================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   ClawBox 外设守护进程 一键部署       ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""

# ── 检查 root ──
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[错误] 请以 root 运行: sudo bash install.sh${NC}"
    exit 1
fi

# ── 路径 ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_SCRIPT="$SCRIPT_DIR/peripheral_daemon.py"
SUPERVISOR_SCRIPT="$SCRIPT_DIR/supervisor.sh"
LOG_FILE="/var/log/clawbox-peripheral.log"
ENV_FILE="/etc/default/clawbox-peripheral"
EPD_DIR="$SCRIPT_DIR/epd-driver"
CLAWBOX_ROOT="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"

_daemon_pids() {
    local pid cmd
    for pid in $(pgrep -f '[p]eripheral_daemon.py' 2>/dev/null || true); do
        [ -r "/proc/$pid/cmdline" ] || continue
        cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
        case "$cmd" in
            *"$DAEMON_SCRIPT"*) echo "$pid" ;;
        esac
    done
}

_supervisor_pids() {
    local pid cmd
    for pid in $(pgrep -f '[s]upervisor.sh' 2>/dev/null || true); do
        [ -r "/proc/$pid/cmdline" ] || continue
        cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
        case "$cmd" in
            *"$SUPERVISOR_SCRIPT"*) echo "$pid" ;;
        esac
    done
}

echo -e "${BLUE}部署目录: ${SCRIPT_DIR}${NC}"
echo ""

# ============================================================
# 第1步: 启用 SPI（墨水屏驱动）
# ============================================================
echo -e "${YELLOW}[1/6] 检查/启用 SPI...${NC}"

NEED_REBOOT=false
if [ -e /dev/spidev1.0 ]; then
    echo "  ✅ SPI1.0 已就绪"
else
    echo "  ⚙️  尝试启用 SPI1.0..."
    if [ -f /boot/config.txt ]; then
        if grep -q "^overlays=" /boot/config.txt 2>/dev/null; then
            if ! grep -q "spidev1_0" /boot/config.txt; then
                sed -i 's/^overlays=.*/& spidev1_0/' /boot/config.txt
                echo "  ✅ 已添加 spidev1_0 到 /boot/config.txt"
                NEED_REBOOT=true
            fi
        else
            echo "overlays=spidev1_0" >> /boot/config.txt
            echo "  ✅ 已添加 overlays=spidev1_0 到 /boot/config.txt"
            NEED_REBOOT=true
        fi
    else
        echo -e "  ${YELLOW}⚠️  未找到 /boot/config.txt，请手动启用 SPI（参考核桃派文档）${NC}"
    fi
    if [ "$NEED_REBOOT" = true ]; then
        echo -e "  ${YELLOW}⚠️  需要重启生效。安装完成后请 reboot${NC}"
    fi
fi
echo ""

# ============================================================
# 第2步: 安装系统依赖
# ============================================================
echo -e "${YELLOW}[2/6] 安装系统依赖...${NC}"

# Python3 基础包（墨水屏驱动 + 守护进程所需的全部系统包）
SYSTEM_PACKAGES=(
    python3 python3-pip
    python3-pil python3-numpy
    python3-spidev
    gpiod python3-libgpiod
    fonts-wqy-zenhei
    fonts-dejavu-core fonts-noto-cjk
    fonts-noto-core
    iw rfkill
)
missing_system_packages=()
for package in "${SYSTEM_PACKAGES[@]}"; do
    if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null \
        | grep -qx 'install ok installed'; then
        missing_system_packages+=("$package")
    fi
done

if [ "${#missing_system_packages[@]}" -gt 0 ]; then
    # 只有确实要安装软件包时才刷新索引，避免重复部署被网络状态拖慢或阻断。
    echo "  ⏳ 缺少系统包: ${missing_system_packages[*]}"
    apt-get update -qq
    apt-get install -y -qq "${missing_system_packages[@]}"
else
    echo "  ✅ 系统包已齐全，跳过 apt-get update"
fi

echo "  ✅ 系统包检查完成"

# ============================================================
# 第3步: 安装 Python 依赖
# ============================================================
echo -e "${YELLOW}[3/6] 安装 Python 依赖...${NC}"

install_python_module() {
    import_name="$1"
    pip_spec="$2"
    apt_pkg="$3"

    if python3 -c "import ${import_name}" 2>/dev/null; then
        echo "  ✅ ${import_name} 已安装"
        return 0
    fi

    echo "  ⏳ 安装 ${pip_spec}..."
    if ! apt-get install -y -qq "$apt_pkg" >/dev/null 2>&1 && \
       ! pip3 install "$pip_spec" --break-system-packages >/dev/null 2>&1; then
        echo -e "  ${RED}❌ ${import_name} 安装失败，请检查 apt/pip 输出后重试${NC}"
        exit 1
    fi

    if python3 -c "import ${import_name}" 2>/dev/null; then
        echo "  ✅ ${import_name} 安装完成"
    else
        echo -e "  ${RED}❌ ${import_name} 安装失败，请检查 apt/pip 输出后重试${NC}"
        exit 1
    fi
}

# gpiod Python 绑定用 Debian 官方包 python3-libgpiod(v1, 与驱动兼容)。
# ⚠️ 旧包名 python3-gpiod 在 Debian12 不存在 → apt 失败会 fallback 到 pip 的 gpiod 2.x
#   (链接 libgpiod.so.3 而系统只有 v1) → GPIO 全报 Errno 2。2026-08-10 新设备实测踩坑。
install_python_module "gpiod" "gpiod" "python3-libgpiod"
install_python_module "qrcode" "qrcode[pil]" "python3-qrcode"
# WhatsApp 高密度二维码必须先解码再按墨水屏像素网格原生重绘；
# 没有 cv2 时只能缩放/裁剪原图，二维码可能显示但无法扫描。
install_python_module "cv2" "opencv-python-headless" "python3-opencv"

echo ""

# ============================================================
# 第4步: 检查硬件 + 验证驱动文件
# ============================================================
echo -e "${YELLOW}[4/6] 检查硬件接口 + 驱动文件...${NC}"

HARDWARE_OK=true

if [ -e /dev/spidev1.0 ]; then
    echo "  ✅ SPI1.0 (/dev/spidev1.0)"
else
    echo -e "  ${RED}❌ SPI1.0 不存在！请在 /boot/config.txt 的 overlays= 中添加 spidev1_0${NC}"
    HARDWARE_OK=false
fi

if python3 -c "import gpiod; gpiod.Chip('gpiochip1')" 2>/dev/null; then
    echo "  ✅ gpiochip1 可访问"
else
    echo -e "  ${YELLOW}⚠️  gpiochip1 不可访问（非 root 运行时会这样，root 下通常正常）${NC}"
fi

if python3 -c "import spidev" 2>/dev/null; then
    echo "  ✅ spidev Python 模块可用"
else
    echo -e "  ${YELLOW}⚠️  spidev Python 模块不可用，屏幕无法初始化${NC}"
fi

# 驱动文件存在性验证
if [ -f "$EPD_DIR/epdconfig.py" ]; then
    echo "  ✅ epdconfig.py (GPIO/SPI 适配层)"
else
    echo -e "  ${RED}❌ $EPD_DIR/epdconfig.py 缺失${NC}"
    HARDWARE_OK=false
fi
if [ -f "$EPD_DIR/epd1in54_152.py" ]; then
    echo "  ✅ epd1in54_152.py (152x152 B&W 驱动)"
else
    echo -e "  ${RED}❌ $EPD_DIR/epd1in54_152.py 缺失${NC}"
    HARDWARE_OK=false
fi

echo "  ℹ️  墨水屏接线: 参考 README.md 接线表"

# ── PWM 风扇检查 ──
if [ -e /sys/class/pwm/pwmchip22 ]; then
    echo "  ✅ PWM pwmchip22 存在"
else
    echo -e "  ${YELLOW}⚠️  PWM pwmchip22 未找到，风扇功能可能不可用${NC}"
fi

if [ "$HARDWARE_OK" = false ]; then
    echo ""
    echo -e "  ${YELLOW}⚠️  硬件检查未通过，守护进程可能无法正常驱动外设${NC}"
    echo -e "  ${YELLOW}   请先启用 SPI1.0 后重启，再重新安装外设包${NC}"
fi

echo ""

# ============================================================
# 第5步: 停止旧进程 & 清理
# ============================================================
echo -e "${YELLOW}[5/6] 停止旧进程...${NC}"

# 写停止标记: 防止停止守护进程期间监督者把它重新拉起 (2026-08-26)
# 停止标记放 /run (tmpfs): 重启即清, 防残留导致永不启动
STOP_FLAG="${CLAWBOX_STOP_FLAG:-/run/clawbox-peripheral.stop}"
touch "$STOP_FLAG"

# 先停监督者: 防止停止守护进程期间监督者把它重新拉起 (2026-08-11)
# 仅停止本部署目录的监督者，避免误伤其他同名脚本。
for pid in $(_supervisor_pids); do kill "$pid" 2>/dev/null || true; done

systemctl stop clawbox-peripheral.service 2>/dev/null || true

# 优雅停止守护进程: SIGTERM → 等待退出确认(最长5s) → 超时强杀 (2026-08-11)
if [ -n "$(_daemon_pids)" ]; then
    for pid in $(_daemon_pids); do kill "$pid" 2>/dev/null || true; done
    echo "  ✅ 已停止旧守护进程"
    for _i in $(seq 1 5); do
        [ -n "$(_daemon_pids)" ] || break
        sleep 1
    done
    if [ -n "$(_daemon_pids)" ]; then
        echo "  ⚠️  守护进程未退出, 强制结束"
        for pid in $(_daemon_pids); do kill -9 "$pid" 2>/dev/null || true; done
        sleep 1
    fi
else
    echo "  ℹ️  没有运行中的守护进程"
fi

# 清理 Python 字节码缓存 (.pyc/__pycache__)，防止代码更新后仍加载旧缓存
echo -e "  🧹 清理 Python 缓存..."
find "$SCRIPT_DIR" -name '*.pyc' -delete 2>/dev/null || true
find "$SCRIPT_DIR" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
echo -e "  ✅ Python 缓存已清理"

# 清理过期的 wechat-qr.json (路径跟随 CLAWBOX_ROOT, 与 config.py 一致)
QR_FILE="$CLAWBOX_ROOT/data/wechat-qr.json"
QR_GROUP="root"
if getent group clawbox >/dev/null 2>&1; then
    QR_GROUP="clawbox"
fi
install -d -m 0770 -o root -g "$QR_GROUP" "$(dirname "$QR_FILE")"
if [ -f "$QR_FILE" ]; then
    rm -f "$QR_FILE"
    echo "  🗑️  已清理过期二维码缓存"
fi

# 确保主程序可执行
chmod +x "$SCRIPT_DIR/peripheral_daemon.py"
# 网络切换脚本 (板载按键触发)
chmod +x "$SCRIPT_DIR/network_action.sh"
# 监督者脚本 (崩溃自动拉起)
chmod +x "$SCRIPT_DIR/supervisor.sh"
# 心跳探针（供硬件看门狗调用）
chmod +x "$SCRIPT_DIR/watchdog_probe.sh" 2>/dev/null || true
# 非 systemd 启动入口共用的环境加载器
chmod +x "$SCRIPT_DIR/runtime_env.sh"

echo ""

# ============================================================
# 第6步: 设置开机自启
# ============================================================
echo -e "${YELLOW}[6/6] 设置开机自启...${NC}"

# 日志由守护进程内 RotatingFileHandler 自轮转(rename 模式, 启动日志不丢),
# 故移除外部 logrotate copytruncate 配置, 避免与进程内轮转冲突 (2026-08-11)
if [ -f /etc/logrotate.d/clawbox-peripheral ]; then
    rm -f /etc/logrotate.d/clawbox-peripheral
    echo -e "  ${YELLOW}🗑️  已移除外部 logrotate 配置 (改为进程内自轮转)${NC}"
fi

# 开机由监督者(supervisor.sh)拉起并 wait 守护进程，以真实退出码处理恢复：
# 无停止标记时无论退出码(0/非零/信号)都自动拉起; 停止标记存在(用户主动停止)
# 时监督者退出。停止标记由 restart_daemon.sh/install.sh 停止阶段写入 (2026-08-26)。
# stdout 丢弃(正常日志走进程内写 LOG_FILE), stderr(崩溃 traceback)落 crash 文件
AUTO_START_CMD="pgrep -f '[/]$SUPERVISOR_SCRIPT' > /dev/null || nohup bash $SUPERVISOR_SCRIPT > /dev/null 2>> /var/log/clawbox-peripheral-crash.log &"

# --- 方式1: rc.local（主要启动方式，已验证可靠） ---
RC_LOCAL="/etc/rc.local"
if [ ! -f "$RC_LOCAL" ]; then
    echo "#!/bin/bash" > "$RC_LOCAL"
    echo "exit 0" >> "$RC_LOCAL"
    chmod +x "$RC_LOCAL"
fi

# 先删除旧的 clawbox-peripheral 启动行（避免重复）
sed -i '/clawbox-peripheral\|peripheral_daemon.py/d' "$RC_LOCAL"
# 在 exit 0 前插入启动命令
sed -i "\$i $AUTO_START_CMD" "$RC_LOCAL"
echo "  ✅ 已配置 rc.local 自启"

# 删除停止标记: install 完成后守护进程恢复"无标记总是拉起"契约 (2026-08-26)
rm -f "$STOP_FLAG"

# --- 方式2: systemd 服务（备用，仅安装不通过它启动） ---
# 注意：核桃派 systemd 有兼容性问题，systemctl start 可能卡死。
# 因此 systemd 服务仅作为备用方案安装，实际启动走 rc.local + nohup。
# 配置版本化刷新 (2026-08-11)
# 背景: 旧 ensure_env_default 只补不覆盖, 升级代码后旧 env 值一直压住 config.py
#   新默认 (如 CLAWBOX_QR_FILE_MAX_BYTES 仍 8192, 而代码默认已 20000 → WhatsApp
#   图片 data URL 会被误判超限删除, 码显示不出来且难排查)。
# 机制: 文件头记 CONFIG_VERSION; install.sh 检测版本低于当前 → 备份旧文件、
#   保留用户自定义键(默认表之外的键)、按新默认重写。版本一致则完全不动。
CONFIG_VERSION="2"   # 升版 +1, 并同步下方默认表与 config.py 的 os.environ 默认值
CONFIG_DEFAULTS=(
    "CLAWBOX_API_URL=http://127.0.0.1:80"
    "CLAWBOX_QR_MAX_LENGTH=2048"
    "CLAWBOX_QR_FILE_MAX_BYTES=20000"
    "CLAWBOX_QR_ALLOWED_SCHEMES=http,https"
)

refresh_config_version() {
    local cur_ver=""
    if [ -f "$ENV_FILE" ]; then
        cur_ver="$(grep -E '^CONFIG_VERSION=' "$ENV_FILE" | head -1 | cut -d= -f2)"
    fi
    [ -n "$cur_ver" ] && [ "$cur_ver" = "$CONFIG_VERSION" ] && return 0

    # 版本不一致/缺失: 先备份旧文件
    local bak=""
    if [ -f "$ENV_FILE" ]; then
        bak="$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
        cp -f "$ENV_FILE" "$bak"
        echo "  ↻ 配置版本 ${cur_ver:-无} → $CONFIG_VERSION (旧文件已备份: $bak)"
    fi

    # 收集用户自定义键(默认表之外的键), 升级时保留
    local custom=""
    if [ -n "$bak" ]; then
        while IFS= read -r line; do
            case "$line" in
                ""|\#*|CONFIG_VERSION=*) continue ;;
                CLAWBOX_API_URL=*|CLAWBOX_QR_MAX_LENGTH=*|CLAWBOX_QR_FILE_MAX_BYTES=*|CLAWBOX_QR_ALLOWED_SCHEMES=*) continue ;;
            esac
            custom="${custom}${line}"$'\n'
        done < "$bak"
    fi

    # 重写: 版本行 + 新默认 + 自定义键
    [ -d "$(dirname "$ENV_FILE")" ] || install -d -m 0755 "$(dirname "$ENV_FILE")"
    {
        echo "CONFIG_VERSION=$CONFIG_VERSION"
        for kv in "${CONFIG_DEFAULTS[@]}"; do echo "$kv"; done
        [ -n "$custom" ] && printf '%s' "$custom"
    } > "$ENV_FILE"
    echo "  ✅ 配置文件已刷新 (版本 $CONFIG_VERSION)"
}

refresh_config_version
chmod 0644 "$ENV_FILE" 2>/dev/null || true
echo "  ✅ 环境配置已就绪: $ENV_FILE"

# 安装 systemd 服务文件(仅备用, 不 enable 自动启动)
# ⚠️ 2026-08-10 修复: 若 enable, 开机 systemd 与 rc.local 会双启动守护进程
#   → 双实例抢 GPIO → K4 重启后按键/LED 全报 Device or resource busy。
#   rc.local(pgrep 防呆)是主要启动方式。
if [ -f "$SCRIPT_DIR/clawbox-peripheral.service" ]; then
    cp -f "$SCRIPT_DIR/clawbox-peripheral.service" /etc/systemd/system/
    systemctl daemon-reload 2>/dev/null || true
    systemctl disable clawbox-peripheral.service 2>/dev/null || true
    echo "  ✅ systemd 服务已安装（仅备用, 不自动启动）"
fi

echo ""

# ============================================================
# 启动服务
# ============================================================
echo -e "${YELLOW}[+] 启动守护进程...${NC}"

# 确保日志文件存在
touch "$LOG_FILE"

# 等待 GPIO/SPI 资源释放
echo -e "  ${BLUE}[1/3] 等待 GPIO/SPI 资源释放...${NC}"
for i in $(seq 1 5); do
    sleep 1
    if gpioinfo 2>/dev/null | grep -q 'consumer="epd"'; then
        echo -n "."
    else
        echo -e " ${GREEN}✅${NC}"
        break
    fi
done

# 由监督者统一拉起守护进程(首次启动 + 崩溃自恢复), 不再直接 nohup 守护进程
# 日志走进程内自轮转; stdout 丢弃, stderr(崩溃 traceback)落 crash 文件 (2026-08-11)
echo -e "  ${BLUE}[2/3] 启动监督者 (supervisor.sh)...${NC}"
for pid in $(_supervisor_pids); do kill "$pid" 2>/dev/null || true; done
nohup bash "$SCRIPT_DIR/supervisor.sh" > /dev/null 2>> /var/log/clawbox-peripheral-crash.log &
echo -e "  ${GREEN}✅ 监督者已启动 (PID $!)${NC}"

# 等待进程就绪
echo -e "  ${BLUE}[3/3] 等待守护进程就绪...${NC}"
for _i in $(seq 1 6); do
    if [ -n "$(_daemon_pids)" ]; then
        echo -e "  ${GREEN}✅ 守护进程 PID $(_daemon_pids | head -1) 已就绪${NC}"
        break
    fi
    sleep 1
done

# 最终验证
if [ -n "$(_daemon_pids)" ]; then
    echo -e "  ${GREEN}✅ 守护进程运行中${NC}"
else
    echo -e "  ${RED}❌ 守护进程未能启动${NC}"
    echo -e "  ${YELLOW}  请手动排查:${NC}"
    echo -e "  ${YELLOW}    sudo python3 $SCRIPT_DIR/peripheral_daemon.py${NC}"
    echo -e "  ${YELLOW}    日志: tail -50 $LOG_FILE${NC}"
    echo -e "  ${RED}安装中止：未输出成功状态，也不会向自动部署返回 0${NC}"
    exit 1
fi

echo ""
# ── 可选：硬件看门狗（需内核支持 /dev/watchdog，失败不阻断安装）──
# ⚠️ 2026-08-24 新板实测: 核桃派 systemd 的 watchdog.service(Type=forking) 在
#    systemctl start/restart 时无限挂起(核桃派 systemd 兼容性坑, 详见 README)。
#    因此两点根治:
#    1) apt 安装 watchdog 前先写 policy-rc.d(exit 101) 阻止 postinst 启动服务,
#       避免 apt-get install 被 postinst 的 systemctl start 拖死; 装完即删。
#    2) 启用走 nohup 直接拉起守护进程 + rc.local 持久化(与 supervisor 同模式),
#       不再依赖 systemd。
if [ -e /dev/watchdog ] || modprobe sunxi_wdt 2>/dev/null; then
  # 安装期屏蔽 systemd 服务自启(防 postinst systemctl start 挂起)
  POLICY_RC_BACKUP=""
  if [ -e /usr/sbin/policy-rc.d ]; then
    POLICY_RC_BACKUP="/usr/sbin/policy-rc.d.clawbox-backup.$$"
    cp -a /usr/sbin/policy-rc.d "$POLICY_RC_BACKUP"
  fi
  restore_policy_rc() {
    if [ -n "$POLICY_RC_BACKUP" ] && [ -e "$POLICY_RC_BACKUP" ]; then
      mv -f "$POLICY_RC_BACKUP" /usr/sbin/policy-rc.d
    else
      rm -f /usr/sbin/policy-rc.d
    fi
  }
  trap restore_policy_rc EXIT INT TERM
  echo '#!/bin/sh' > /usr/sbin/policy-rc.d
  echo 'exit 101' >> /usr/sbin/policy-rc.d
  chmod +x /usr/sbin/policy-rc.d
  if command -v watchdog >/dev/null 2>&1 || timeout 60 apt-get install -y -qq watchdog 2>/dev/null; then
    restore_policy_rc
    trap - EXIT INT TERM
    # apt 安装会留下 enabled 的 systemd unit(postinst update-rc.d fallback);
    # 本脚本启用走 nohup, 必须 disable 系统 unit 防开机自启(探针契约未验证/核桃派 systemd 不稳)
    systemctl disable watchdog 2>/dev/null || true
    cat >/etc/watchdog.conf <<'WDOG'
watchdog-device = /dev/watchdog
watchdog-timeout = 60
interval = 15
test-binary = /home/clawbox/clawbox-deploy/clawbox-peripheral/watchdog_probe.sh
WDOG
    # ⚠️ 2026-08-24 实机: 看门狗探针(watchdog_probe.sh)与守护进程心跳的契约
    #    未在新板验证, 启用后喂狗失败 → 板子被看门狗重启。因此**默认不自动启用**,
    #    需要时设 CLAWBOX_ENABLE_WATCHDOG=1 再跑 install.sh(与旧板一致: 无看门狗)。
    if [ "${CLAWBOX_ENABLE_WATCHDOG:-0}" = "1" ]; then
      # 停旧实例后经 nohup 拉起(不走 systemd, 防挂起)
      pkill -f '[w]atchdog -c /etc/watchdog.conf' 2>/dev/null || true
      nohup watchdog -c /etc/watchdog.conf >/dev/null 2>&1 &
      # rc.local 持久化(幂等, 与 supervisor 启动行同模式)
      if [ -f /etc/rc.local ]; then
        WATCHDOG_CMD="pgrep -f '[w]atchdog -c /etc/watchdog.conf' > /dev/null || nohup watchdog -c /etc/watchdog.conf > /dev/null 2>&1 &"
        grep -q 'watchdog -c /etc/watchdog.conf' /etc/rc.local || sed -i "\$i $WATCHDOG_CMD" /etc/rc.local
      fi
      echo -e "  ${GREEN}✅ 硬件看门狗已启用 (opt-in, nohup+rc.local, 60s)${NC}"
    else
      # 默认不启用: 清理上次可能残留的看门狗(进程 + rc.local 行)
      pkill -f '[w]atchdog -c /etc/watchdog.conf' 2>/dev/null || true
      sed -i '\|watchdog -c /etc/watchdog.conf|d' /etc/rc.local 2>/dev/null || true
      echo -e "  ${YELLOW}ℹ️  硬件看门狗未启用 (需 CLAWBOX_ENABLE_WATCHDOG=1; 探针契约未验证)${NC}"
    fi
  else
    rm -f /usr/sbin/policy-rc.d
    echo -e "  ${YELLOW}⚠️  硬件看门狗安装失败，跳过${NC}"
  fi
else
  rm -f /usr/sbin/policy-rc.d 2>/dev/null || true
  echo -e "  ${YELLOW}ℹ️  无 /dev/watchdog，跳过硬件看门狗${NC}"
fi

echo ""
echo -e "  日志文件: ${BLUE}$LOG_FILE${NC}"
echo -e "  实时查看: ${BLUE}tail -f $LOG_FILE${NC}"

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         部署完成！                     ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "  日常管理命令:"
echo -e "    查看日志:  ${BLUE}tail -f $LOG_FILE${NC}"
echo -e "    停止服务:  ${BLUE}sudo pkill -f peripheral_daemon.py${NC}"
echo -e "    重新部署:  ${BLUE}scp 更新文件后, cd $SCRIPT_DIR && sudo bash install.sh${NC}"
echo ""
echo -e "  按键操作:"
echo -e "    K1 → 页面1 (局域网二维码)    长按K1 → 按键说明"
echo -e "    K2 → 页面2 (微信二维码)      K4短按 → 重启"
echo -e "    K3 → 页面3 (WiFi 状态)       K4长按3秒 → 关机"
echo ""

[ "$NEED_REBOOT" = true ] && echo -e "  ${YELLOW}⚠️  SPI 刚启用，请重启: sudo reboot${NC}"
echo ""
echo -e "${GREEN}✅ 安装完成！${NC}"
