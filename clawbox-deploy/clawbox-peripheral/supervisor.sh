#!/bin/bash
# =================================================================
# supervisor.sh —— 外设守护进程监督者（无停止标记总是拉起, 有标记才退出）
#
# 背景 (2026-08-11): rc.local 只在开机拉起一次守护进程, 进程异常退出后
#   无任何机制自动恢复(历史上曾因"rc.local 不会自动重启"吃过亏)。本脚本
#   常驻, 守护进程退出后依据"停止标记"判断该不该拉起。
#
# 机制 (2026-08-26 重构):
#   监督者直接启动并 wait 自己的子进程, 守护进程退出后检查停止标记:
#     - 存在停止标记 → 用户明确要求停止 (restart_daemon.sh/install.sh 停止
#       阶段写入) → 监督者退出, 不再拉起 (应当死去时死去)
#     - 不存在停止标记 → 无论退出码 (0/非零/被信号杀死) 都重新拉起
#       (应当活着时活着)
#   修复 2026-08-26 压测发现: 误发 SIGTERM 使守护进程 status=0 优雅退出,
#   旧逻辑"0 不重启"导致监督者也退出, 设备永久哑掉 (屏幕/按键/风扇全停)。
#   停止标记放 /run (tmpfs) 而非 /var: 重启即清, 天然防"标记残留导致
#   永不启动"。这也覆盖 Python 尚未来得及写健康标记便启动失败, 以及主循环
#   捕获未知异常后执行了资源清理的场景; 旧的标记文件仅保留作运行状态观测。
#
# 崩溃风暴保护: 连续快速崩溃则退避, 防止"拉起→崩溃"死循环打满 CPU。
#
# 注意: 与 restart_daemon.sh / install.sh 配合 —— 它们停止守护进程时会
#  先写停止标记再停本监督者(见 pkill -f supervisor.sh), 避免停止途中被
#  重新拉起。
# =================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if ! . "$SCRIPT_DIR/runtime_env.sh"; then
    exit 1
fi
DAEMON_SCRIPT="$SCRIPT_DIR/peripheral_daemon.py"
DAEMON_SCRIPT="${CLAWBOX_DAEMON_SCRIPT:-$DAEMON_SCRIPT}"
PYTHON_BIN="${CLAWBOX_PYTHON_BIN:-python3}"
CRASH_LOG="${CLAWBOX_CRASH_LOG:-/var/log/clawbox-peripheral-crash.log}"
BACKOFF_AFTER="${CLAWBOX_CRASH_BACKOFF_AFTER:-5}"
BACKOFF_SECONDS="${CLAWBOX_CRASH_BACKOFF_SECONDS:-60}"
STABLE_SECONDS="${CLAWBOX_CRASH_STABLE_SECONDS:-300}"
# 停止标记: 存在 = 用户明确要求停止, 守护进程退出后监督者不再拉起;
# 不存在 = 无论退出码都拉起。放 /run (tmpfs) 重启即清, 防残留 (2026-08-26)
STOP_FLAG="${CLAWBOX_STOP_FLAG:-/run/clawbox-peripheral.stop}"

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

# 崩溃日志防无界增长: 超过上限时清空重来 (2026-08-14 审查 P2-5)
CRASH_LOG_MAX_BYTES="${CLAWBOX_CRASH_LOG_MAX_BYTES:-1048576}"
if [ -f "$CRASH_LOG" ] && [ "$(stat -c%s "$CRASH_LOG" 2>/dev/null || echo 0)" -gt "$CRASH_LOG_MAX_BYTES" ]; then
    : > "$CRASH_LOG"
fi

crash_count=0

# 启动前清孤儿 daemon（应对 supervisor 被 kill -9 后 daemon 仍活的缝隙）
if [ -n "$(_daemon_pids)" ]; then
    echo "[supervisor] 检测到孤儿守护进程，先清理" >>"$CRASH_LOG"
    for pid in $(_daemon_pids); do kill "$pid" 2>/dev/null || true; done
    for _ in $(seq 1 5); do [ -n "$(_daemon_pids)" ] || break; sleep 1; done
    if [ -n "$(_daemon_pids)" ]; then
        for pid in $(_daemon_pids); do kill -9 "$pid" 2>/dev/null || true; done
        sleep 1
    fi
fi

HEARTBEAT_FILE="${CLAWBOX_HEARTBEAT_FILE:-/run/clawbox-peripheral.heartbeat}"
HEARTBEAT_STALE="${CLAWBOX_HEARTBEAT_STALE:-30}"
HEARTBEAT_CHECK_EVERY="${CLAWBOX_HEARTBEAT_CHECK_EVERY:-15}"
HEARTBEAT_GRACE="${CLAWBOX_HEARTBEAT_GRACE:-60}"
# 心跳文件缺失的缓冲上限: 缺失 ≠ 卡死 (真卡死 = 文件存在但过期)。
# 进程刚启动还没写第一个心跳、/run 短暂异常都会造成缺失; 持续缺失超过
# 本缓冲才判死 (2026-08-24 02:24 曾因"缺失→9999→立即 kill"误杀健康进程)。
HEARTBEAT_MISSING_TIMEOUT="${CLAWBOX_HEARTBEAT_MISSING_TIMEOUT:-90}"
PROCESS_POLL_EVERY="${CLAWBOX_PROCESS_POLL_EVERY:-1}"

_heartbeat_age() {
    if [ ! -f "$HEARTBEAT_FILE" ]; then echo 9999; return; fi
    now=$(cut -d' ' -f1 /proc/uptime 2>/dev/null || echo 0)
    heartbeat=$(awk 'NF >= 1 {print $1; exit}' "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
    awk -v now="$now" -v heartbeat="$heartbeat" 'BEGIN {
        age = now - heartbeat
        if (age < 0) age = 0
        printf "%d\n", age
    }'
}

while true; do
    started_at=$(date +%s)
    nohup "$PYTHON_BIN" "$DAEMON_SCRIPT" > /dev/null 2>>"$CRASH_LOG" &
    daemon_pid=$!
    echo "[supervisor] $(date '+%F %T') 已启动守护进程 pid=$daemon_pid" >>"$CRASH_LOG"

    # 后台子 shell 不能可靠 wait 父 shell 的子进程；父 shell 轮询存活并最终
    # wait 一次，既保留真实退出码，也能持续执行心跳巡检。
    daemon_status=0
    last_heartbeat_check=0
    missing_since=""
    while kill -0 "$daemon_pid" 2>/dev/null; do
        sleep "$PROCESS_POLL_EVERY"
        if ! kill -0 "$daemon_pid" 2>/dev/null; then
            break
        fi
        uptime_now=$(($(date +%s) - started_at))
        if [ "$((uptime_now - last_heartbeat_check))" -lt "$HEARTBEAT_CHECK_EVERY" ]; then
            continue
        fi
        last_heartbeat_check=$uptime_now
        if [ "$uptime_now" -lt "$HEARTBEAT_GRACE" ]; then
            continue
        fi
        if [ ! -f "$HEARTBEAT_FILE" ]; then
            # 缺失 ≠ 卡死: 先缓冲 (uptime 时间轴), 文件一旦出现立即重置计时;
            # 只有持续缺失超过 HEARTBEAT_MISSING_TIMEOUT 才判死 (2026-08-24 修复)。
            if [ -z "$missing_since" ]; then
                missing_since=$uptime_now
                echo "[supervisor][watchdog] 心跳文件缺失, 开始 ${HEARTBEAT_MISSING_TIMEOUT}s 缓冲 (pid=$daemon_pid)" >>"$CRASH_LOG"
            elif [ $((uptime_now - missing_since)) -ge "$HEARTBEAT_MISSING_TIMEOUT" ]; then
                echo "[supervisor][watchdog] 心跳文件缺失超过 ${HEARTBEAT_MISSING_TIMEOUT}s, 判定异常, kill -9 pid=$daemon_pid" >>"$CRASH_LOG"
                kill -9 "$daemon_pid" 2>/dev/null || true
                break
            fi
        else
            missing_since=""
            age=$(_heartbeat_age)
            if [ "$age" -ge "$HEARTBEAT_STALE" ]; then
                echo "[supervisor][watchdog] 心跳超时 ${age}s (>${HEARTBEAT_STALE}s)，判定卡死，kill -9 pid=$daemon_pid" >>"$CRASH_LOG"
                kill -9 "$daemon_pid" 2>/dev/null || true
                break
            fi
        fi
    done
    wait "$daemon_pid" 2>/dev/null
    daemon_status=$?
    uptime_s=$(($(date +%s) - started_at))

    # 应当死去时死去: 存在停止标记(用户主动停止) → 监督者退出, 不再拉起。
    # 应当活着时活着: 无标记 → 无论退出码(0/非零/信号)都重新拉起。
    # 修复 2026-08-26 压测发现: 误发 SIGTERM 使守护进程 status=0 优雅退出,
    # 旧逻辑"0 不重启"导致监督者也退出, 设备永久哑掉。
    if [ -f "$STOP_FLAG" ]; then
        echo "[supervisor] $(date '+%F %T') 检测到停止标记, 监督者退出 (status=$daemon_status)" >>"$CRASH_LOG"
        exit 0
    fi

    # 运行足够久后才崩溃，不计入连续快速崩溃，避免零散故障累计触发退避。
    if [ "$uptime_s" -ge "$STABLE_SECONDS" ]; then
        crash_count=0
    fi
    crash_count=$((crash_count + 1))
    echo "[supervisor] $(date '+%F %T') 守护进程退出(status=$daemon_status, uptime=${uptime_s}s), 重新拉起" >>"$CRASH_LOG"

    if [ "$crash_count" -ge "$BACKOFF_AFTER" ]; then
        echo "[supervisor] $(date '+%F %T') 连续快速崩溃 $crash_count 次, 退避 ${BACKOFF_SECONDS}s" >>"$CRASH_LOG"
        sleep "$BACKOFF_SECONDS"
        crash_count=0
    fi
done
