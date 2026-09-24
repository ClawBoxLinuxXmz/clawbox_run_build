#!/bin/bash
# =================================================================
# ClawBox 从零部署一键脚本（设备端）
# ----------------------------------------------------------------
# 前置（文件传输由部署者自己完成, 需 IP/密码）:
#   1. 建用户: useradd -m -s /bin/bash clawbox && usermod -aG dialout,sudo,audio,video,netdev,i2c clawbox
#   2. scp 部署包 → /home/clawbox/clawbox-deploy/ (clawbox-peripheral/ + frontend-systemd/)
#   3. scp 前端源码 → /tmp/frontend-src/  (已是标准布局: 配置留根 + src/ 源码, 目录名先转 ASCII 避免乱码)
#   4. scp 本脚本 → /home/clawbox/
# 用法: bash /home/clawbox/deploy_all.sh
# 完成: 外设守护 + Node22 + swap + 前端 + systemd服务 + OpenClaw 网关
# 幂等: 可重复运行, 已完成的步骤自动跳过
# 注意: SPI 首次启用需重启; 脚本会提示 reboot 后重跑(跳过已完成)
# =================================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[deploy]${NC} $*"; }
ok()   { echo -e "${GREEN}  ✅ $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠️  $*${NC}"; }
die()  { echo -e "${RED}  ❌ $*${NC}"; exit 1; }

DEPLOY_ROOT=/home/clawbox/clawbox-deploy
FRONTEND_SRC=/tmp/frontend-src
CLAWBOX_DIR=/home/clawbox/clawbox
export PATH=/opt/node22/bin:$PATH

[ "$(id -u)" -eq 0 ] || die "请以 root 运行本脚本"
echo -e "${GREEN}════════════ ClawBox 从零部署一键脚本 ════════════${NC}"

# ── 前置检查（文件传输由部署者自己完成, 此处只校验就位）────────
if ! id clawbox >/dev/null 2>&1; then
    die "clawbox 用户不存在; 请先在设备端执行: useradd -m -s /bin/bash clawbox && usermod -aG dialout,sudo,audio,video,netdev,i2c clawbox"
fi
[ -f "$DEPLOY_ROOT/clawbox-peripheral/install.sh" ] || die "部署包未传到 $DEPLOY_ROOT (先 scp clawbox-deploy 到设备)"
[ -d "$FRONTEND_SRC" ] || die "前端源码未传到 $FRONTEND_SRC (先 scp 前端源码到设备, 目录名建议先转 ASCII 避免乱码)"
ok "前置检查通过"

# ── [1/6] 外设守护进程 ────────────────────────────────────────
log "[1/6] 外设守护进程 (install.sh)"
if [ -f "$DEPLOY_ROOT/clawbox-peripheral/install.sh" ]; then
    (cd "$DEPLOY_ROOT/clawbox-peripheral" && bash install.sh) || die "install.sh 失败, 见上方日志"
    ok "外设守护已安装"
else
    die "找不到 $DEPLOY_ROOT/clawbox-peripheral/install.sh (未传部署包?)"
fi

# ── [2/6] Node v22 + swap ─────────────────────────────────────
log "[2/6] Node v22 + swap"
if [ ! -x /opt/node22/bin/node ]; then
    log "  下载 Node v22.23.2 (需联网, 约 50MB)..."
    cd /tmp
    wget -q https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-arm64.tar.xz || die "Node 下载失败, 检查网络"
    tar -xJf node-v22.23.2-linux-arm64.tar.xz
    mv node-v22.23.2-linux-arm64 /opt/node22
    ln -sf /opt/node22/bin/node /usr/local/bin/node
    ln -sf /opt/node22/bin/npm /usr/local/bin/npm
    ln -sf /opt/node22/bin/npx /usr/local/bin/npx
    ok "Node $(/opt/node22/bin/node -v)"
else
    ok "Node 已存在 $(/opt/node22/bin/node -v)"
fi

if ! grep -q '/swapfile' /etc/fstab 2>/dev/null; then
    log "  创建 1.5G swap (防前端 build OOM)..."
    fallocate -l 1.5G /swapfile && chmod 600 /swapfile
    mkswap /swapfile && swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "swap 已启用"
else
    ok "swap 已存在"
fi

# ── [3/6] SPI 就绪检查（首次启用需重启）───────────────────────
log "[3/6] SPI 检查"
if [ ! -e /dev/spidev1.0 ]; then
    warn "SPI1.0 刚启用, 需要重启才能生效"
    warn "请执行: reboot"
    warn "重启后重新运行: bash /home/clawbox/deploy_all.sh (已完成步骤会自动跳过)"
    exit 0
fi
ok "SPI1.0 就绪"

# ── [4/6] 前端部署 ─────────────────────────────────────────────
log "[4/6] 前端部署"
if [ ! -d "$FRONTEND_SRC" ]; then
    die "找不到前端源码 $FRONTEND_SRC (未 scp?)"
fi
if [ ! -f "$CLAWBOX_DIR/package.json" ] || [ ! -f "$CLAWBOX_DIR/.next/BUILD_ID" ]; then
    mkdir -p "$CLAWBOX_DIR"
    # 用 cp -a 合并(不删守护进程建的 data/); 勿用 mv
    cp -a "$FRONTEND_SRC/." "$CLAWBOX_DIR/"
    cd "$CLAWBOX_DIR"
    log "  npm install (需联网, 较久)..."
    npm install || die "npm install 失败"
    log "  npm run build ..."
    npm run build || die "前端 build 失败"
    chown -R clawbox:clawbox "$CLAWBOX_DIR"
    ok "前端已构建"
else
    ok "前端已存在 (package.json + .next), 跳过 build"
fi

# ── [5/6] systemd 服务 ─────────────────────────────────────────
log "[5/6] systemd 服务"
if [ ! -f "$DEPLOY_ROOT/frontend-systemd/install_services.sh" ]; then
    die "找不到 $DEPLOY_ROOT/frontend-systemd/install_services.sh (未 scp frontend-systemd?)"
fi
(cd "$DEPLOY_ROOT/frontend-systemd" && bash install_services.sh /opt/node22/bin/node) || die "install_services.sh 失败"
# 2026-08-05 修复: NetworkManager-wait-online 拖住 rc.local 1min36s → 守护进程开机 68s 才启动;
# 禁用后 rc.local/守护进程提前 ~70s (旧设备 137 已验证)。
systemctl disable NetworkManager-wait-online.service >/dev/null 2>&1 || true
systemctl enable --now clawbox-setup >/dev/null 2>&1 || true
systemctl restart clawbox-setup >/dev/null 2>&1 || true   # 让 polkit/组生效
# clawbox-ap: 开机自动判断连 WiFi 还是开热点 (start-ap.sh: setup_complete+已保存WiFi → 自动连, 否则开热点引导配置)
systemctl enable clawbox-ap >/dev/null 2>&1 || true
ok "clawbox-setup 服务已装并启动"

# ── [6/6] OpenClaw 网关 ───────────────────────────────────────
log "[6/6] OpenClaw 网关"
if [ ! -x /home/clawbox/.npm-global/bin/openclaw ]; then
    log "  安装 OpenClaw 2026.7.1-2 (需联网)..."
    npm install -g openclaw@2026.7.1-2 --prefix /home/clawbox/.npm-global || die "openclaw 安装失败"
    chown -R clawbox:clawbox /home/clawbox/.npm-global
    ok "OpenClaw 已安装"
else
    ok "OpenClaw 已存在"
fi

SRC_OC="$DEPLOY_ROOT/frontend-systemd/openclaw.json"
DST_OC=/home/clawbox/.openclaw/openclaw.json
if [ -f "$SRC_OC" ]; then
    mkdir -p /home/clawbox/.openclaw
    if [ -f "$DST_OC" ]; then
        # 重跑部署不能覆盖用户已配置的渠道凭据、模型和 token。
        chown clawbox:clawbox "$DST_OC"
        ok "openclaw.json 已存在, 保留现有配置"
    else
        # 在临时副本生成随机 token, 不改写部署包模板, 避免多台设备复用 token。
        TMP_OC=$(mktemp /tmp/clawbox-openclaw.XXXXXX)
        cp "$SRC_OC" "$TMP_OC"
        if grep -q CHANGE_ME_RANDOM_HEX "$TMP_OC" 2>/dev/null; then
            TOKEN=$(openssl rand -hex 21)
            sed -i "s/CHANGE_ME_RANDOM_HEX/$TOKEN/" "$TMP_OC"
            ok "openclaw.json token 已生成"
        fi
        install -o clawbox -g clawbox -m 0600 "$TMP_OC" "$DST_OC"
        rm -f "$TMP_OC"
        ok "openclaw.json 已部署"
    fi
else
    die "找不到 $SRC_OC (frontend-systemd 未 scp?)"
fi

log "  安装插件(微信/QQ/WhatsApp/deepseek/飞书, 已装的会忽略)..."
PLUGIN_LIST_COMPACT=$(timeout 60 sudo -u clawbox -H env PATH=/opt/node22/bin:$PATH \
    /home/clawbox/.npm-global/bin/openclaw plugins list 2>/dev/null | tr -d '[:space:]' || true)
plugin_present() {
    [[ -n "$PLUGIN_LIST_COMPACT" && "$PLUGIN_LIST_COMPACT" == *"$1"* ]]
}
PLUGIN_FAILURES=0
for ENTRY in \
  "@tencent-weixin/openclaw-weixin@2.4.6|openclaw-weixin" \
  "@openclaw/qqbot|qqbot" \
  "clawhub:@openclaw/whatsapp|whatsapp" \
  "@openclaw/deepseek-provider|deepseek" \
  "@openclaw/feishu|feishu" \
  "clawhub:@openclaw/line|line"; do
    PLUG="${ENTRY%%|*}"
    PLUGIN_ID="${ENTRY#*|}"
    if plugin_present "$PLUGIN_ID"; then
        ok "插件 $PLUG 已存在"
        continue
    fi
    PLUGIN_LOG=$(mktemp /tmp/clawbox-plugin.XXXXXX)
    if timeout 180 sudo -u clawbox -H env PATH=/opt/node22/bin:$PATH \
        /home/clawbox/.npm-global/bin/openclaw plugins install "$PLUG" >"$PLUGIN_LOG" 2>&1; then
        ok "插件 $PLUG"
    else
        PLUGIN_FAILURES=$((PLUGIN_FAILURES + 1))
        warn "插件 $PLUG 安装失败 (最近输出: $(tail -n 3 "$PLUGIN_LOG" | tr '\n' ' '))"
    fi
    rm -f "$PLUGIN_LOG"
done
[ "$PLUGIN_FAILURES" -eq 0 ] || die "$PLUGIN_FAILURES 个插件安装失败, 请检查网络/npm 日志后重跑"

systemctl enable --now clawbox-gateway >/dev/null 2>&1 || true

# ── 验证 ───────────────────────────────────────────────────────
log "验证(等待网关启动)..."
# 网关首次启动要加载 10+ 插件(实测 10~20s), 固定 sleep 20 偶发不够 → 误报"未监听";
# 改为轮询: 最多等 90s, 每 3s 查一次, 就绪即继续 (2026-08-26 修复)。
GATEWAY_READY=0
for _i in $(seq 1 30); do
    if ss -tln 2>/dev/null | grep -q ':18789'; then GATEWAY_READY=1; break; fi
    sleep 3
done
echo "  HTTP(:80):    $(curl -sI http://127.0.0.1/ 2>/dev/null | head -1 || echo 未响应)"
if [ "$GATEWAY_READY" = "1" ]; then echo "  网关(:18789): 监听中"; else echo "  网关(:18789): 未监听(90s 超时, 请 journalctl -u clawbox-gateway 排查)"; fi
if systemctl is-active --quiet clawbox-setup; then echo "  Setup(:80):    active"; else echo "  Setup(:80):    未运行"; fi
if pgrep -f '[/]home/clawbox/clawbox-deploy/clawbox-peripheral/peripheral_daemon[.]py' >/dev/null 2>&1; then echo "  守护进程:     运行中"; else echo "  守护进程:     未运行"; fi

[ "$GATEWAY_READY" = "1" ] || die "网关未监听, 部署未完成"
systemctl is-active --quiet clawbox-setup || die "clawbox-setup 未运行, 部署未完成"
pgrep -f '[/]home/clawbox/clawbox-deploy/clawbox-peripheral/peripheral_daemon[.]py' >/dev/null 2>&1 \
    || die "外设守护进程未运行, 部署未完成"

echo -e "${GREEN}════════════ 一键部署完成 ════════════${NC}"
echo "最后一步(手动): 浏览器访问 http://<设备IP>/ 按 /setup 向导配置 AI Key + 聊天渠道"
