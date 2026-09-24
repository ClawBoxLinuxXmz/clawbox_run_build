#!/usr/bin/env bash
set -euo pipefail

HOTSPOT_ENV_FILE="/home/clawbox/clawbox/data/hotspot.env"
if [ -f "$HOTSPOT_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$HOTSPOT_ENV_FILE"
fi

resolve_wifi_iface() {
  local preferred="${NETWORK_INTERFACE:-}"

  if [ -n "$preferred" ] && nmcli -t -f GENERAL.TYPE device show "$preferred" 2>/dev/null | grep -q '^GENERAL.TYPE:wifi$'; then
    echo "$preferred"
    return 0
  fi

  local detected
  detected=$(nmcli -t -f DEVICE,TYPE device status 2>/dev/null | awk -F: '$2=="wifi" {print $1; exit}')
  if [ -n "$detected" ]; then
    echo "$detected"
    return 0
  fi

  detected=$(iw dev 2>/dev/null | awk '/Interface/ {print $2}' | head -1)
  if [ -n "$detected" ]; then
    echo "$detected"
    return 0
  fi

  return 1
}

IFACE="$(resolve_wifi_iface || true)"
AP_IP="192.168.4.1"
AP_SSID="${HOTSPOT_SSID:-ClawBox-Setup}"
AP_PASSWORD="${HOTSPOT_PASSWORD:-}"
CONFIG_FILE="/home/clawbox/clawbox/data/config.json"
FORCE_AP="${CLAWBOX_FORCE_AP:-0}"
DHCP_WAIT_MS="${CLAWBOX_DHCP_WAIT_MS:-45000}"
DHCP_POLL_MS="${CLAWBOX_DHCP_POLL_MS:-1500}"

if [ -z "$IFACE" ]; then
  echo "[AP] No WiFi interface detected (check driver/rfkill)" >&2
  exit 1
fi

echo "[AP] Starting hotspot on interface: $IFACE"

if [ "${HOTSPOT_DISABLED:-0}" = "1" ]; then
  echo "[AP] Hotspot disabled by configuration"
  exit 0
fi

ensure_wifi_ready() {
  rfkill unblock wifi 2>/dev/null || true
  nmcli radio wifi on 2>/dev/null || true
  nmcli device set "$IFACE" managed yes 2>/dev/null || true
  ip link set "$IFACE" up 2>/dev/null || true
}

if ! ip link show "$IFACE" >/dev/null 2>&1; then
  echo "[AP] WiFi interface '$IFACE' not found" >&2
  exit 1
fi

ensure_wifi_ready

wait_for_ipv4() {
  local elapsed=0
  while [ "$elapsed" -lt "$DHCP_WAIT_MS" ]; do
    local ip
    ip=$(nmcli -g IP4.ADDRESS device show "$IFACE" 2>/dev/null | head -n1 | cut -d/ -f1)
    if [ -n "$ip" ]; then
      echo "$ip"
      return 0
    fi
    sleep "$(awk "BEGIN { print $DHCP_POLL_MS / 1000 }")"
    elapsed=$((elapsed + DHCP_POLL_MS))
  done
  return 1
}

# 如果设置已完成，先尝试连接WiFi
if [ "$FORCE_AP" != "1" ] && [ -f "$CONFIG_FILE" ]; then
  if node -e "process.exit(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8')).setup_complete?0:1)" 2>/dev/null; then
    echo "[AP] Setup complete, trying to connect to saved WiFi first"
    while IFS= read -r profile; do
      [ -z "$profile" ] && continue
      echo "[AP] Trying saved WiFi: $profile"
      if nmcli connection up "$profile" ifname "$IFACE" 2>/dev/null; then
        WIFI_STATE=$(nmcli -t -f GENERAL.STATE device show "$IFACE" 2>/dev/null | cut -d: -f2)
        if echo "$WIFI_STATE" | grep -q '(connected)'; then
          if IP_ADDR=$(wait_for_ipv4); then
            echo "[AP] WiFi connected to '$profile' with IP $IP_ADDR, skipping hotspot"
            exit 0
          fi
          echo "[AP] '$profile' associated but no DHCP lease arrived, falling back to hotspot"
        fi
      fi
    done < <(nmcli -t -f NAME,TYPE connection show | awk -F: -v ap="$AP_SSID" '$2 == "wifi" && $1 != ap {print $1}')
    echo "[AP] No saved WiFi connected, falling back to hotspot"
  fi
fi

# 清理旧连接
echo "[AP] Cleaning up old connections..."
nmcli connection down "$AP_SSID" 2>/dev/null || true
nmcli connection delete "$AP_SSID" 2>/dev/null || true

# 创建新热点
echo "[AP] Creating hotspot: $AP_SSID"
nmcli connection add \
  type wifi \
  ifname "$IFACE" \
  con-name "$AP_SSID" \
  ssid "$AP_SSID" \
  autoconnect no \
  connection.interface-name "$IFACE" \
  wifi.mode ap \
  wifi.band bg \
  wifi.channel 6 \
  ipv4.method shared \
  ipv4.addresses "$AP_IP/24" \
  ipv6.method ignore

# 配置安全
if [ -n "$AP_PASSWORD" ]; then
  nmcli connection modify "$AP_SSID" \
    802-11-wireless-security.key-mgmt wpa-psk \
    802-11-wireless-security.psk "$AP_PASSWORD"
else
  nmcli connection modify "$AP_SSID" remove 802-11-wireless-security 2>/dev/null || true
fi

# 启动热点
echo "[AP] Activating hotspot..."
nmcli connection up "$AP_SSID" ifname "$IFACE"

# 启用IP转发
sysctl -w net.ipv4.ip_forward=1 >/dev/null

echo "[AP] Hotspot started successfully!"
echo "[AP] Connect to WiFi: $AP_SSID"
echo "[AP] Access setup at: http://192.168.4.1/setup"
