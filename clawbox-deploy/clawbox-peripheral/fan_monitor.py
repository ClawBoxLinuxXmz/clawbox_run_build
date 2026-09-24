#!/usr/bin/env python3
"""
ClawBox 风扇/温度实时监控工具
==============================
独立运行，不依赖守护进程。直接从 sysfs 读取温度和 PWM 状态。

用法:
    python3 fan_monitor.py              # 默认每2秒刷新
    python3 fan_monitor.py -i 1         # 每秒刷新
    python3 fan_monitor.py --once       # 单次输出后退出

在核桃派上运行:
    cd /home/clawbox/clawbox-peripheral
    sudo python3 fan_monitor.py
"""

import argparse
import os
import sys
import time
from typing import Optional

# 确保能导入同目录 config
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from config import (
    FAN_HYSTERESIS,
    FAN_MIN_EFFECTIVE_DUTY,
    FAN_PWM_CHANNEL,
    FAN_PWM_CHIP,
    FAN_PWM_PERIOD_NS,
    FAN_SPEED_CURVE,
    FAN_START_STOP_HYSTERESIS,
    FAN_TEMP_SENSOR,
)
from fan_curve import interpolate_duty
from fan_sysfs import (
    read_cooling_state as _read_cooling_state,
)
from fan_sysfs import (
    read_pwm_duty as _read_pwm_duty,
)
from fan_sysfs import (
    read_pwm_enabled as _read_pwm_enabled,
)
from fan_sysfs import (
    read_temp as _read_temp,
)
from fan_sysfs import (
    read_thermal_governor as _read_thermal_governor,
)

# ============================================================
# 配置（从 config.py 导入，保持单一数据源）
# ============================================================
PWM_CHIP = FAN_PWM_CHIP
PWM_CHANNEL = FAN_PWM_CHANNEL
PWM_PERIOD_NS = FAN_PWM_PERIOD_NS
TEMP_SENSOR = FAN_TEMP_SENSOR
SPEED_CURVE = FAN_SPEED_CURVE
MIN_EFFECTIVE_DUTY = FAN_MIN_EFFECTIVE_DUTY
HYSTERESIS = FAN_HYSTERESIS
START_STOP_HYSTERESIS = FAN_START_STOP_HYSTERESIS

# ============================================================
# 终端颜色 (ANSI)
# ============================================================
C_RESET = "\033[0m"
C_BOLD = "\033[1m"
C_RED = "\033[91m"
C_GREEN = "\033[92m"
C_YELLOW = "\033[93m"
C_CYAN = "\033[96m"
C_DIM = "\033[2m"
C_CLEAR = "\033[2J\033[H"  # 清屏并移到左上角


def read_temp() -> Optional[float]:
    """读取 CPU 温度 (°C)"""
    try:
        return _read_temp(TEMP_SENSOR)
    except (OSError, ValueError):
        return None


def read_pwm_duty() -> Optional[float]:
    """读取 PWM 占空比 (%)"""
    try:
        return _read_pwm_duty(PWM_CHIP, PWM_CHANNEL)
    except (OSError, ValueError):
        return None


def read_pwm_enabled() -> Optional[bool]:
    """读取 PWM 是否启用"""
    try:
        return _read_pwm_enabled(PWM_CHIP, PWM_CHANNEL)
    except OSError:
        return None


def read_thermal_governor() -> str:
    """读取 thermal governor"""
    return _read_thermal_governor()


def read_cooling_state() -> Optional[int]:
    """读取 pwm-fan cooling_device cur_state"""
    return _read_cooling_state()


def calc_target_duty(temp_c: float, curve=None) -> float:
    """根据温控曲线计算目标占空比（不带滞回，纯计算）。

    与 fan_controller 共享 fan_curve.interpolate_duty 实现 (规则三去重)。
    """
    return interpolate_duty(temp_c, curve if curve is not None else SPEED_CURVE)


def temp_bar(temp: float, width: int = 30) -> str:
    """生成温度条形图"""
    low, high = SPEED_CURVE[0][0], SPEED_CURVE[-1][0]
    ratio = max(0.0, min(1.0, (temp - low) / (high - low)))
    filled = int(ratio * width)

    if ratio < 0.33:
        color = C_GREEN
    elif ratio < 0.67:
        color = C_YELLOW
    else:
        color = C_RED

    bar = color + "█" * filled + C_DIM + "░" * (width - filled) + C_RESET
    return f"[{bar}]"


def duty_bar(pct: float, width: int = 20) -> str:
    """生成风扇占空比条形图"""
    ratio = max(0.0, min(1.0, pct / 100.0))
    filled = int(ratio * width)

    if pct < 1:
        color = C_DIM
    elif pct < 50:
        color = C_GREEN
    elif pct < 80:
        color = C_YELLOW
    else:
        color = C_RED

    bar = color + "█" * filled + C_DIM + "░" * (width - filled) + C_RESET
    return f"[{bar}]"


def temp_color(temp: float) -> str:
    """温度着色"""
    if temp < 50:
        return C_GREEN
    elif temp < 65:
        return C_YELLOW
    else:
        return C_RED


def pwm_status_text(duty: Optional[float], enabled: Optional[bool]) -> str:
    """PWM 状态文本"""
    if duty is None:
        return f"{C_RED}不可用{C_RESET}"
    if enabled is False:
        return f"{C_YELLOW}已禁用{C_RESET}"
    if duty < 1:
        return f"{C_DIM}停转{C_RESET}"
    return f"{C_CYAN}运行中{C_RESET}"


def print_header() -> None:
    """打印表头"""
    print(C_CLEAR, end="")
    print(f"{C_BOLD}{C_CYAN}╔══════════════════════════════════════════════════════╗{C_RESET}")
    print(f"{C_BOLD}{C_CYAN}║{C_RESET}         {C_BOLD}ClawBox 风扇/温度 实时监控{C_RESET}                    {C_BOLD}{C_CYAN}║{C_RESET}")
    print(f"{C_BOLD}{C_CYAN}╚══════════════════════════════════════════════════════╝{C_RESET}")
    print()

    # 温控曲线
    curve_parts = []
    for t, d in SPEED_CURVE:
        curve_parts.append(f"{t}°C→{d:.0f}%")
    print(f"  {C_DIM}温控曲线: {', '.join(curve_parts)}  最低有效: {MIN_EFFECTIVE_DUTY}%  回滞: {HYSTERESIS}°C  启停回差: {START_STOP_HYSTERESIS}°C{C_RESET}")
    gov = read_thermal_governor()
    cstate = read_cooling_state()
    print(f"  {C_DIM}PWM: pwmchip{PWM_CHIP}/pwm{PWM_CHANNEL}  period={PWM_PERIOD_NS}ns  |  thermal: {gov}")
    if cstate is not None:
        print(f"  {C_DIM}cooling_device cur_state={cstate} (levels: 0→0.4%, 1→47%, 2→59%, 3→78%, 4→98%){C_RESET}")
    print()
    print(f"  {'时间':<10s}  {'CPU温度':>8s}  {'温度条':<36s}  {'风扇占空比':>10s}  {'风扇条':<24s}  {'PWM状态'}")
    print(f"  {'─'*10}  {'─'*8}  {'─'*36}  {'─'*10}  {'─'*24}  {'─'*8}")


def print_status(temp: Optional[float], duty: Optional[float],
                 enabled: Optional[bool], target: Optional[float]) -> None:
    """打印一行状态"""
    now = time.strftime("%H:%M:%S")

    if temp is not None:
        temp_str = f"{temp_color(temp)}{temp:6.1f}°C{C_RESET}"
        t_bar = temp_bar(temp)
    else:
        temp_str = f"{C_RED}  N/A{C_RESET}"
        t_bar = f"{C_RED}[传感器不可用]{C_RESET}"

    if duty is not None:
        duty_str = f"{duty:6.1f}%"
        d_bar = duty_bar(duty)
    else:
        duty_str = f"{C_RED}  N/A{C_RESET}"
        d_bar = f"{C_RED}[PWM不可用]{C_RESET}"

    status = pwm_status_text(duty, enabled)

    # 目标占空比（如果温度有效）
    target_str = ""
    if temp is not None and target is not None:
        target_str = f"  (目标: {target:.0f}%)"

    # thermal governor 状态
    gov = read_thermal_governor()
    cstate = read_cooling_state()
    thermal_str = ""
    if cstate is not None:
        thermal_str = f"  thermal: {gov} cur={cstate}"

    line = f"  {now:<10s}  {temp_str:>16s}  {t_bar}  {duty_str:>16s}  {d_bar}  {status}{target_str}{thermal_str}"
    print(line)


def run_once() -> None:
    """单次输出"""
    temp = read_temp()
    duty = read_pwm_duty()
    enabled = read_pwm_enabled()
    target = calc_target_duty(temp) if temp is not None else None

    print(f"CPU温度:     {temp:.1f}°C" if temp is not None else "CPU温度:     N/A")
    print(f"风扇占空比:  {duty:.1f}%" if duty is not None else "风扇占空比:  N/A")
    print(f"目标占空比:  {target:.0f}%" if target is not None else "目标占空比:  N/A")
    print(f"PWM启用:     {'是' if enabled else '否' if enabled is not None else 'N/A'}")


def run_continuous(interval: float) -> None:
    """持续监控"""
    print_header()
    try:
        while True:
            # 移到行首（不清屏，保留历史）
            sys.stdout.write("\033[5A")  # 上移5行到数据行开始
            sys.stdout.write("\033[J")    # 清除到屏幕底部

            temp = read_temp()
            duty = read_pwm_duty()
            enabled = read_pwm_enabled()
            target = calc_target_duty(temp) if temp is not None else None

            print_status(temp, duty, enabled, target)
            print()  # 空行

            # 等待时短暂睡眠
            time.sleep(min(interval, 1.0))
            # 剩余时间分片
            remaining = interval - 1.0
            while remaining > 0:
                time.sleep(min(remaining, 1.0))
                remaining -= 1.0

    except KeyboardInterrupt:
        print(f"\n{C_YELLOW}监控已停止{C_RESET}")
    except Exception as e:
        print(f"\n{C_RED}错误: {e}{C_RESET}")


def main():
    parser = argparse.ArgumentParser(
        description="ClawBox 风扇/温度实时监控工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python3 fan_monitor.py              # 每2秒刷新（默认）
  python3 fan_monitor.py -i 1         # 每秒刷新
  python3 fan_monitor.py --once       # 单次输出
        """,
    )
    parser.add_argument(
        "-i", "--interval",
        type=float,
        default=2.0,
        help="刷新间隔(秒)，默认2秒",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="只输出一次，不持续刷新",
    )
    args = parser.parse_args()

    if args.once:
        run_once()
    else:
        run_continuous(args.interval)


if __name__ == "__main__":
    main()
