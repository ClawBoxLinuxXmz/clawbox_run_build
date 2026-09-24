"""
风扇温控曲线纯计算 —— 插值 / 滞回 / 档位映射
==============================================
从 fan_controller.py 抽离 (2026-08-11 工程化重构):
  - fan_controller 与 fan_monitor 共用同一实现, 消除重复 (规则三)
  - 纯函数, 无 sysfs/IO 依赖, 可在 PC 上单测
"""

from typing import List

from fan_sysfs import PWM_FULL_SCALE


def interpolate_duty(temp_c: float, curve) -> float:
    """按温控曲线计算目标占空比 (无滞回)。

    低于首档 → 首档 duty; 高于末档 → 末档 duty; 中间线性插值。
    """
    if not curve:
        return 0.0
    if temp_c <= curve[0][0]:
        return float(curve[0][1])
    if temp_c >= curve[-1][0]:
        return float(curve[-1][1])
    for i in range(len(curve) - 1):
        t0, d0 = curve[i]
        t1, d1 = curve[i + 1]
        if t0 <= temp_c <= t1:
            ratio = (temp_c - t0) / (t1 - t0)
            return d0 + (d1 - d0) * ratio
    return 0.0


def calc_target_duty(temp_c: float, curve, hysteresis: float, direction_up: bool) -> float:
    """按温控曲线计算目标占空比 (带滞回)。

    direction_up=False (降温过程): 有效温度 = 实测温度 - 滞回, 延迟降速,
    避免温度在阈值附近抖动导致频繁变速。
    """
    if not curve:
        return 0.0
    if temp_c <= curve[0][0]:
        return float(curve[0][1])
    if temp_c >= curve[-1][0]:
        return float(curve[-1][1])
    for i in range(len(curve) - 1):
        t0, d0 = curve[i]
        t1, d1 = curve[i + 1]
        if t0 <= temp_c <= t1:
            ratio = (temp_c - t0) / (t1 - t0)
            target = d0 + (d1 - d0) * ratio
            if not direction_up and hysteresis > 0:
                effective_temp = temp_c - hysteresis
                if effective_temp <= t0:
                    target = float(d0)
                elif effective_temp >= t1:
                    target = float(d1)
                else:
                    ratio_hyst = (effective_temp - t0) / (t1 - t0)
                    target = d0 + (d1 - d0) * ratio_hyst
            return target
    return 0.0


def duty_to_state(duty_pct: float, levels: List[int], cdev_max: int,
                  offset: float = 18.0) -> int:
    """目标占空比 → thermal cooling_device cur_state (离散档位)。

    kernel cooling-levels 如 [1,120,150,200,250] (/255), 用较大 offset 确保
    风扇在合理温度启动 (见 fan_controller 历史注释):
      target ≥ 29% → state 1 (47% duty) / ≥41% → state 2 / ≥60% → state 3 / ≥80% → state 4
    """
    level_duties = [lv / PWM_FULL_SCALE * 100 for lv in levels]
    best = 0
    for s in range(min(len(level_duties), cdev_max + 1)):
        if level_duties[s] <= duty_pct + offset:
            best = s
    return min(best, cdev_max)


def duty_outside_dead_band(current_duty: float, target_duty: float,
                           dead_band: float) -> bool:
    """占空比死区判定: 目标与已应用占空比相差 ≥ 死区 才认为需要更新。

    原因: 温度传感器噪声 (±0.2°C) 会让目标占空比在曲线阈值附近反复横跳
    (实机 47~48°C 时 30%↔36% 每 3s 抖动, 2026-08-12 审计 OBS-02 实测),
    死区把小抖动吸收掉, 只在实际温差足够大时才变速。
    """
    return abs(target_duty - current_duty) >= dead_band
