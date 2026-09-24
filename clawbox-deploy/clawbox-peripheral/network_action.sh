#!/usr/bin/env bash
# ClawBox 网络模式切换与无中断恢复动作。
# 临时热点使用独立 wlan0ap；主 wlan0 保持 managed，交给 NetworkManager 自动重连。
set -euo pipefail

CLAWBOX_ROOT="${CLAWBOX_ROOT:-/home/clawbox/clawbox}"
SCRIPTS_DIR="${CLAWBOX_SCRIPTS_DIR:-/home/clawbox/clawbox/scripts}"
FORCE_AP_FLAG="${CLAWBOX_FORCE_AP_FLAG:-$CLAWBOX_ROOT/data/force_ap}"
RECOVERY_AP_IFACE="${CLAWBOX_RECOVERY_AP_IFACE:-wlan0ap}"
SETTLE_MS="${WIFI_AP_DOWN_SETTLE_MS:-1500}"
AUTO_WAIT_MS="${CLAWBOX_AUTO_WAIT_MS:-20000}"
AUTO_POLL_MS="${CLAWBOX_AUTO_POLL_MS:-1000}"

resolve_client_iface() {
  local preferred="${CLAWBOX_CLIENT_IFACE:-${NETWORK_INTERFACE:-}}"
  if [ -n "$preferred" ] && [ "$preferred" != "$RECOVERY_AP_IFACE" ] \
      && nmcli -t -f GENERAL.TYPE device show "$preferred" 2>/dev/null \
      | grep -q '^GENERAL.TYPE:wifi$'; then
    echo "$preferred"
    return 0
  fi

  local detected
  detected=$(nmcli -t -f DEVICE,TYPE device status 2>/dev/null \
    | awk -F: -v recovery="$RECOVERY_AP_IFACE" \
      '$2=="wifi" && $1!=recovery {print $1; exit}')
  if [ -n "$detected" ]; then
    echo "$detected"
    return 0
  fi

  detected=$(iw dev 2>/dev/null \
    | awk -v recovery="$RECOVERY_AP_IFACE" '/Interface/ && $2!=recovery {print $2; exit}')
  if [ -n "$detected" ]; then
    echo "$detected"
    return 0
  fi
  return 1
}

iface_exists() {
  iw dev "$1" info >/dev/null 2>&1
}

is_ap_mode() {
  iw dev "$1" info 2>/dev/null | grep -q 'type AP'
}

is_client_connected() {
  if is_ap_mode "$1"; then
    return 1
  fi
  local state
  state=$(nmcli -g GENERAL.STATE device show "$1" 2>/dev/null || true)
  case "$state" in
    100*) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_wifi_ready() {
  local iface="$1"
  rfkill unblock wifi 2>/dev/null || true
  nmcli radio wifi on 2>/dev/null || true
  nmcli device set "$iface" managed yes 2>/dev/null || true
  ip link set "$iface" up 2>/dev/null || true
}

request_saved_wifi_connection() {
  local iface="$1"
  # 用户主动断开会抑制 autoconnect；交给 NetworkManager 选 profile 可避开
  # 中文 SSID 转义匹配，也不会像逐个 profile 尝试那样长时间卡住按键。
  if nmcli --wait 0 device connect "$iface" >/dev/null 2>&1; then
    echo "[net] 已请求 NetworkManager 连接已保存 WiFi"
    return 0
  fi
  echo "[net] 主动连接请求不可用，继续等待自动连接" >&2
  return 1
}

ensure_recovery_iface() {
  local client_iface="$1"
  if iface_exists "$RECOVERY_AP_IFACE"; then
    ensure_wifi_ready "$RECOVERY_AP_IFACE"
    return 0
  fi

  local phy_index
  phy_index=$(iw dev "$client_iface" info 2>/dev/null \
    | awk '$1=="wiphy" {print $2; exit}')
  if [ -z "$phy_index" ]; then
    echo "[net] 无法确定 $client_iface 所属无线 PHY" >&2
    return 1
  fi

  # 驱动已在实机验证支持 managed+AP 并发；独立接口避免任何重连探测打断热点。
  iw phy "phy${phy_index}" interface add "$RECOVERY_AP_IFACE" type __ap
  ensure_wifi_ready "$RECOVERY_AP_IFACE"
  nmcli device set "$RECOVERY_AP_IFACE" autoconnect no 2>/dev/null || true
  sleep 0.5
  echo "[net] 已创建独立热点接口: $RECOVERY_AP_IFACE"
}

start_hotspot_on() {
  local iface="$1"
  NETWORK_INTERFACE="$iface" CLAWBOX_FORCE_AP=1 \
    bash "$SCRIPTS_DIR/start-ap.sh"
}

stop_hotspot_on() {
  local iface="$1"
  NETWORK_INTERFACE="$iface" bash "$SCRIPTS_DIR/stop-ap.sh" || true
}

stop_recovery_hotspot() {
  if ! iface_exists "$RECOVERY_AP_IFACE"; then
    return 0
  fi
  if is_ap_mode "$RECOVERY_AP_IFACE"; then
    stop_hotspot_on "$RECOVERY_AP_IFACE"
  fi
  iw dev "$RECOVERY_AP_IFACE" del 2>/dev/null || true
  echo "[net] 已撤除独立临时热点接口: $RECOVERY_AP_IFACE"
}

start_recovery_hotspot() {
  local client_iface="$1"
  if is_ap_mode "$RECOVERY_AP_IFACE"; then
    echo "[net] 独立临时热点已在运行: $RECOVERY_AP_IFACE"
    ensure_wifi_ready "$client_iface"
    return 0
  fi
  ensure_recovery_iface "$client_iface"
  if ! start_hotspot_on "$RECOVERY_AP_IFACE"; then
    echo "[net] 独立临时热点启动失败" >&2
    stop_recovery_hotspot
    return 1
  fi
  # start-ap.sh 会迁移同名 AP profile；再次确保主接口立即回到 managed/autoconnect。
  ensure_wifi_ready "$client_iface"
  nmcli device set "$client_iface" autoconnect yes 2>/dev/null || true
  echo "[net] 独立临时热点已启动，$client_iface 保持后台自动重连"
}

wait_for_wifi_autoconnect() {
  local iface="$1"
  local elapsed=0
  while [ "$elapsed" -lt "$AUTO_WAIT_MS" ]; do
    local state ip
    state=$(nmcli -g GENERAL.STATE device show "$iface" 2>/dev/null || true)
    ip=$(nmcli -g IP4.ADDRESS device show "$iface" 2>/dev/null \
      | head -n1 | cut -d/ -f1)
    case "$state" in
      100*)
        if ! is_ap_mode "$iface" && [ -n "$ip" ]; then
          echo "[net] WiFi 已连接 ($state), IP=$ip"
          return 0
        fi
        ;;
    esac
    local step_s
    # 避免每轮轮询 fork 一个 awk 计算固定换算 (2026-08-14 审查 P2-3)
    step_s=$((AUTO_POLL_MS / 1000))
    [ "$step_s" -lt 1 ] && step_s=1
    sleep "$step_s"
    elapsed=$((elapsed + AUTO_POLL_MS))
  done
  return 1
}

# 仅直接执行时解析动作；被 source 时只导出函数供单测/复用 (2026-08-14 审查 P1-3)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then

action="${1:-}"

case "$action" in
  hotspot)
    # data 目录由安装器设为 0770 root:clawbox；install -d 会把已有目录
    # 静默改成 0755，导致前端后续写配置失败。
    mkdir -p "$(dirname "$FORCE_AP_FLAG")"
    touch "$FORCE_AP_FLAG"
    echo "[net] 已写入手动热点标记: $FORCE_AP_FLAG"

    IFACE="$(resolve_client_iface || true)"
    if [ -z "$IFACE" ]; then
      echo "[net] 未找到WiFi客户端接口" >&2
      exit 1
    fi
    stop_recovery_hotspot
    start_hotspot_on "$IFACE"
    ;;

  wifi)
    rm -f "$FORCE_AP_FLAG"
    echo "[net] 已清除手动热点标记"

    IFACE="$(resolve_client_iface || true)"
    if [ -z "$IFACE" ]; then
      echo "[net] 未找到WiFi客户端接口，维持现有热点" >&2
      exit 1
    fi

    # 先把热点迁到独立接口，再释放 wlan0；等待连接期间用户仍可访问设备。
    if ! start_recovery_hotspot "$IFACE"; then
      echo "[net] 无法创建并行热点，将使用兼容切换路径" >&2
    fi
    if is_ap_mode "$IFACE"; then
      stop_hotspot_on "$IFACE"
      sleep "$(awk "BEGIN { print $SETTLE_MS / 1000 }")"
    fi
    ensure_wifi_ready "$IFACE"

    request_saved_wifi_connection "$IFACE" || true
    echo "[net] 等待 NetworkManager 自动连接已保存 WiFi（热点保持可用）..."
    if wait_for_wifi_autoconnect "$IFACE"; then
      stop_recovery_hotspot
      exit 0
    fi

    if is_ap_mode "$RECOVERY_AP_IFACE"; then
      echo "[net] 暂无已保存 WiFi 可连，继续保留临时热点"
    else
      echo "[net] 临时热点不可用，回退到主接口热点"
      start_hotspot_on "$IFACE"
    fi
    ;;

  auto-hotspot)
    if [ -e "$FORCE_AP_FLAG" ]; then
      echo "[net] 用户已选择手动热点，自动恢复不接管"
      exit 0
    fi
    IFACE="$(resolve_client_iface || true)"
    if [ -z "$IFACE" ]; then
      echo "[net] 未找到WiFi客户端接口" >&2
      exit 1
    fi
    if is_client_connected "$IFACE"; then
      echo "[net] WiFi 已自行恢复，无需创建临时热点"
      exit 0
    fi
    start_recovery_hotspot "$IFACE"
    ;;

  auto-hotspot-stop)
    if [ -e "$FORCE_AP_FLAG" ]; then
      echo "[net] 用户手动热点优先，跳过自动撤除"
      exit 0
    fi
    stop_recovery_hotspot
    ;;

  *)
    echo "用法: $0 hotspot|wifi|auto-hotspot|auto-hotspot-stop" >&2
    exit 1
    ;;
esac

fi
