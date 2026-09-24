"""
ClawBox 外设守护进程 —— 关机/重启动作
=======================================
公共电源动作逻辑: 先停屏幕线程、熄灯、清屏, 再执行系统命令。
从 peripheral_daemon.py 抽离 (2026-08-11 工程化重构), 消除 K4 短按/长按
两条路径的重复代码。
"""

import logging
import subprocess
from typing import TYPE_CHECKING

from host_cmds import CMD_REBOOT, CMD_SHUTDOWN

logger = logging.getLogger("clawbox.power")

if TYPE_CHECKING:
    from daemon_state import DaemonState

_SCREEN_STOP_TIMEOUT = 6.0


def do_power_action(action: str, *, state: "DaemonState", screen_worker=None) -> bool:
    """关机或重启（公共逻辑）。

    返回命令是否已成功发起。只有发起成功才置 running=False 让主循环退出；
    失败时保持运行，守护进程继续服务，避免"命令失败却优雅退出、监督者不再
    拉起、设备外设全灭"的裸奔 (2026-08-14 审查 P0-3)。

    Args:
        action: "shutdown" | "reboot"
        state: DaemonState (用于置 running=False 与熄灭 LED)
        screen_worker: ScreenWorker (退出前停线程避免 SPI 处于不确定态, 再清屏)
    """
    if action == "shutdown":
        logger.info("执行关机...")
        cmd = [CMD_SHUTDOWN, "-h", "now"]
    else:
        logger.info("执行重启...")
        cmd = [CMD_REBOOT]

    # 先发起命令，确认成功后才做退出动作。失败则原样返回、不触碰任何状态，
    # 主循环继续运行（屏幕线程/LED 均不受影响）。
    try:
        subprocess.run(cmd, timeout=5)
    except Exception as e:
        label = "关机" if action == "shutdown" else "重启"
        logger.error(f"{label}命令失败: {e}，守护进程继续运行")
        return False

    state.running = False

    # 常规刷新 BUSY 最长约 5 秒，因此给 6 秒等待。若仍未停稳，宁可跳过清屏，
    # 也不能让主线程与尚在刷新的工作线程并发访问同一 SPI 设备。
    screen_stopped = True
    if screen_worker is not None:
        screen_stopped = screen_worker.stop(timeout=_SCREEN_STOP_TIMEOUT)
        if not screen_stopped:
            logger.warning("屏幕工作线程仍在刷新，跳过清屏以避免并发访问 SPI")

    if state.led:
        try:
            state.led.all_off()
        except Exception:
            pass
    screen = screen_worker.screen if screen_worker is not None else None
    if screen_stopped and screen and screen.available:
        try:
            screen.clear()
        except Exception:
            pass
    return True


def do_shutdown(state: "DaemonState", screen_worker=None) -> bool:
    """关机"""
    return do_power_action("shutdown", state=state, screen_worker=screen_worker)


def do_reboot(state: "DaemonState", screen_worker=None) -> bool:
    """重启"""
    return do_power_action("reboot", state=state, screen_worker=screen_worker)
