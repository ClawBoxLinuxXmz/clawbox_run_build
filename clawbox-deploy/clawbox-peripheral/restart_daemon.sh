#!/usr/bin/env bash
# 重启外设守护进程: 确保旧实例完全退出、GPIO 释放后再启动
# 2026-08-07 增强: systemd 感知(active 先停服务) + 启动前确认旧实例已清空,
# 杜绝"双实例抢屏幕 SPI"风险。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if ! . "$SCRIPT_DIR/runtime_env.sh"; then
  exit 1
fi
DAEMON_PATTERN="peripheral_daemon.py"
DAEMON_CMD="$SCRIPT_DIR/peripheral_daemon.py"
LOG_FILE="/var/log/clawbox-peripheral.log"
SERVICE="clawbox-peripheral.service"
# 保留 6 秒让硬件初始化日志落盘；命名后避免与停机超时混淆。
STARTUP_REPORT_DELAY_SECONDS=6

_daemon_pids() {
  local pid cmd
  for pid in $(pgrep -f '[p]eripheral_daemon.py' 2>/dev/null || true); do
    [ -r "/proc/$pid/cmdline" ] || continue
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
    case "$cmd" in
      *"$DAEMON_CMD"*) echo "$pid" ;;
    esac
  done
}

_supervisor_pids() {
  local pid cmd
  for pid in $(pgrep -f '[s]upervisor.sh' 2>/dev/null || true); do
    [ -r "/proc/$pid/cmdline" ] || continue
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
    case "$cmd" in
      *"$SCRIPT_DIR/supervisor.sh"*) echo "$pid" ;;
    esac
  done
}

# 1) systemd 服务若 active: Restart=always 会在 pkill 后自动拉起,
#    必须先停掉并同步等待 fully inactive (State=inactive, not deactivating)
if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  echo "systemd 服务 $SERVICE 处于 active, 先停止"
  timeout 20 systemctl stop "$SERVICE" 2>/dev/null || echo "⚠️ systemctl stop 失败, 继续 pkill 清理"
  for _ in $(seq 1 10); do
    st=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
    if [ "$st" != "active" ] && [ "$st" != "activating" ] && [ "$st" != "deactivating" ]; then break; fi
    sleep 1
  done
  systemctl reset-failed "$SERVICE" 2>/dev/null || true
fi

# 1.4) 写停止标记: 防止清理旧实例期间监督者看到守护进程退出而重新拉起 (2026-08-26)
# 停止标记放 /run (tmpfs): 重启即清, 防残留导致永不启动
STOP_FLAG="${CLAWBOX_STOP_FLAG:-/run/clawbox-peripheral.stop}"
touch "$STOP_FLAG"

# 1.5) 先停监督者并等其完全退出: 防止清理旧实例期间被重新拉起 (竞态) (2026-08-11/08-21)
# ⚠️ 匹配模式用 [x] 正则技巧: 避免 pgrep/pkill 匹配到自身或其他同类进程 (2026-08-11 实机踩坑)
for pid in $(_supervisor_pids); do kill "$pid" 2>/dev/null || true; done
for i in $(seq 1 8); do
  if [ -z "$(_supervisor_pids)" ]; then break; fi
  sleep 1
done
if [ -n "$(_supervisor_pids)" ]; then
  echo "⚠️ 监督者未退出, 强制终止"
  for pid in $(_supervisor_pids); do kill -9 "$pid" 2>/dev/null || true; done
  sleep 1
fi
# 再等一次，确保 supervisor 的子 daemon 已随之收敛（并发 restart 产生多 sup 时）
for i in $(seq 1 8); do
  if [ -z "$(_supervisor_pids)" ]; then break; fi
  sleep 1
done

# 2) 清理旧实例: SIGTERM → 等待最多 10s → 仍未退出则 SIGKILL
# 先等 systemd 完全 inactive，再清 sup，最后清 daemon，避免三方同时拉起
for pid in $(_daemon_pids); do kill "$pid" 2>/dev/null || true; done
for i in $(seq 1 10); do
  if [ -z "$(_daemon_pids)" ]; then
    break
  fi
  sleep 1
done
if [ -n "$(_daemon_pids)" ]; then
  echo "⚠️ 旧实例未退出, 强制终止"
  for pid in $(_daemon_pids); do kill -9 "$pid" 2>/dev/null || true; done
  sleep 2
fi

# 3) 最终确认: 仍有残留就中止, 绝不带着旧实例起新实例
if [ -n "$(_daemon_pids)" ]; then
  echo "❌ 旧实例仍未退出, 中止重启。请人工检查: pgrep -af '[p]eripheral_daemon.py'"
  exit 1
fi

# 4) 由监督者启动并直接 wait 守护进程。监督者必须是 Python 的父进程，
# 才能依据真实退出码区分优雅停止与异常退出，不能先手工 nohup Python。
SUPERVISOR_SH="$(dirname "$DAEMON_CMD")/supervisor.sh"
if [ ! -f "$SUPERVISOR_SH" ]; then
  echo "❌ supervisor.sh 不存在, 中止重启 ($SUPERVISOR_SH)"
  exit 1
fi
# 删除停止标记: 让监督者按"无标记总是拉起"契约正常管理守护进程 (2026-08-26)
rm -f "$STOP_FLAG"
nohup bash "$SUPERVISOR_SH" > /dev/null 2>> /var/log/clawbox-peripheral-crash.log &
sleep "$STARTUP_REPORT_DELAY_SECONDS"
echo "=== 进程 ==="
pgrep -af '[p]eripheral_daemon.py' || echo "未启动"
echo "=== LED/按键初始化结果 ==="
grep -E "LED \[|板载按键|初始化失败|Device or resource busy|按键初始化完成" /var/log/clawbox-peripheral.log | tail -12

# 5) 确认监督者仍在运行
if [ -n "$(_supervisor_pids)" ]; then
  echo "=== 监督者已在运行 ==="
else
  echo "❌ 监督者未能启动"
  exit 1
fi
