#!/bin/bash
# watchdog_probe.sh — 供硬件看门狗喂狗前调用
# 返回 0 健康 / 非 0 不健康（停止喂狗触发物理重启）
set -e
HEARTBEAT_FILE="${CLAWBOX_HEARTBEAT_FILE:-/run/clawbox-peripheral.heartbeat}"
HEARTBEAT_STALE="${CLAWBOX_HEARTBEAT_STALE:-30}"
HEARTBEAT_GRACE="${CLAWBOX_HEARTBEAT_GRACE:-60}"
LIVE_MARK="${CLAWBOX_LIVE_MARK:-/run/clawbox-peripheral.live}"

daemon_alive() {
  [ -r "$LIVE_MARK" ] || return 1
  daemon_pid=$(awk 'NF >= 1 {print $1; exit}' "$LIVE_MARK" 2>/dev/null || true)
  case "$daemon_pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$daemon_pid" 2>/dev/null
}

if [ ! -f "$HEARTBEAT_FILE" ]; then
  if daemon_alive; then
    now=$(cut -d' ' -f1 /proc/uptime 2>/dev/null || echo 0)
    started=$(awk 'NF >= 2 {print $2; exit}' "$LIVE_MARK" 2>/dev/null || echo 0)
    if awk -v now="$now" -v started="$started" -v grace="$HEARTBEAT_GRACE" 'BEGIN { exit !((now - started) < grace) }'; then
      exit 0
    fi
  fi
  exit 1
fi
now=$(cut -d' ' -f1 /proc/uptime 2>/dev/null || echo 0)
heartbeat=$(awk 'NF >= 1 {print $1; exit}' "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
age=$(awk -v now="$now" -v heartbeat="$heartbeat" 'BEGIN { age = now - heartbeat; if (age < 0) age = 0; printf "%d\n", age }')
if [ "$age" -ge "$HEARTBEAT_STALE" ]; then
  echo "watchdog stale ${age}s" >&2
  exit 2
fi
if ! daemon_alive; then
  echo "daemon not running" >&2
  exit 3
fi
exit 0
