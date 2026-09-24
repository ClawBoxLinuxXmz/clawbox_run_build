#!/usr/bin/env bash
set -euo pipefail

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
HOTSPOT_ENV_FILE="/home/clawbox/clawbox/data/hotspot.env"
if [ -f "$HOTSPOT_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$HOTSPOT_ENV_FILE"
fi
AP_SSID="${HOTSPOT_SSID:-ClawBox-Setup}"

if [ -z "$IFACE" ]; then
  echo "[AP] No WiFi interface detected; nothing to stop"
  exit 0
fi

echo "[AP] Stopping hotspot on interface: $IFACE..."

rfkill unblock wifi 2>/dev/null || true
nmcli radio wifi on 2>/dev/null || true
nmcli device set "$IFACE" managed yes 2>/dev/null || true
ip link set "$IFACE" up 2>/dev/null || true

nmcli connection down "$AP_SSID" 2>/dev/null || true
nmcli connection delete "$AP_SSID" 2>/dev/null || true

echo "[AP] Hotspot stopped"
