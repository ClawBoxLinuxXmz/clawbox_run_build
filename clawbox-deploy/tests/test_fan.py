"""fan_controller.py / fan_monitor.py —— 温控曲线与档位映射单测。

FanController 在 PC 上构造不会崩: sysfs 路径不存在时自动降级为"仅监控",
我们只测纯计算逻辑 (_calc_target_duty / _duty_to_state)。
"""

import pytest

import fan_curve
import fan_sysfs
from fan_controller import FanController
from fan_monitor import calc_target_duty as monitor_calc

CURVE = [(40, 0), (45, 30), (55, 50), (65, 75), (75, 100)]


def _fc():
    return FanController(
        pwm_chip=0, pwm_channel=5, period_ns=10000, max_duty=9999,
        temp_sensor="/nonexistent/temp",
        speed_curve=list(CURVE),
        hysteresis=3.0, check_interval=3.0,
        min_effective_duty=30.0, start_stop_hysteresis=8.0,
    )


# ---- _calc_target_duty (插值 + 滞回) ----

def test_calc_below_curve_stops():
    assert _fc()._calc_target_duty(30.0) == 0.0


def test_calc_above_curve_full_speed():
    assert _fc()._calc_target_duty(90.0) == 100.0


def test_calc_exact_point():
    assert _fc()._calc_target_duty(45.0) == 30.0
    assert _fc()._calc_target_duty(75.0) == 100.0


def test_calc_linear_interpolation():
    # 50°C 在 (45,30)~(55,50) 中点 → 40%
    assert _fc()._calc_target_duty(50.0) == pytest.approx(40.0)


def test_calc_heating_no_hysteresis():
    fc = _fc()
    fc._direction_up = True
    assert fc._calc_target_duty(50.0) == pytest.approx(40.0)


def test_calc_cooling_applies_hysteresis():
    fc = _fc()
    fc._direction_up = False
    # 冷却时有效温度 = 50 - 3 = 47 → 30 + (47-45)/10*20 = 34%
    assert fc._calc_target_duty(50.0) == pytest.approx(34.0)


# ---- _duty_to_state (thermal 离散档位) ----

def test_duty_to_state_mapping():
    fc = _fc()
    fc._sysfs.cdev_max = 4
    # levels [1,120,150,200,250]/255*100 = [0.39,47.06,58.82,78.43,98.04], offset=18
    assert fc._duty_to_state(10.0) == 0
    assert fc._duty_to_state(30.0) == 1    # 30+18=48 >= 47.06
    assert fc._duty_to_state(50.0) == 2    # 50+18=68 >= 58.82
    assert fc._duty_to_state(70.0) == 3    # 70+18=88 >= 78.43
    assert fc._duty_to_state(90.0) == 4    # 全速


def test_duty_to_state_clamped_to_cdev_max():
    fc = _fc()
    fc._sysfs.cdev_max = 2
    assert fc._duty_to_state(90.0) == 2


# ---- fan_monitor.calc_target_duty (纯计算, 无滞回) ----

def test_monitor_calc_target_duty():
    assert monitor_calc(30.0, CURVE) == 0.0
    assert monitor_calc(90.0, CURVE) == 100.0
    assert monitor_calc(50.0, CURVE) == pytest.approx(40.0)


# ---- fan_curve 共享纯函数 (fan_controller 与 fan_monitor 共用的单一实现) ----

def test_fan_curve_interpolate_duty():
    assert fan_curve.interpolate_duty(30.0, CURVE) == 0.0
    assert fan_curve.interpolate_duty(90.0, CURVE) == 100.0
    assert fan_curve.interpolate_duty(50.0, CURVE) == pytest.approx(40.0)
    assert fan_curve.interpolate_duty(50.0, []) == 0.0


def test_fan_curve_calc_target_duty_hysteresis():
    assert fan_curve.calc_target_duty(50.0, CURVE, 3.0, True) == pytest.approx(40.0)
    assert fan_curve.calc_target_duty(50.0, CURVE, 3.0, False) == pytest.approx(34.0)


def test_fan_curve_duty_to_state():
    levels = [1, 120, 150, 200, 250]
    assert fan_curve.duty_to_state(10.0, levels, 4) == 0
    assert fan_curve.duty_to_state(30.0, levels, 4) == 1
    assert fan_curve.duty_to_state(50.0, levels, 4) == 2
    assert fan_curve.duty_to_state(70.0, levels, 4) == 3
    assert fan_curve.duty_to_state(90.0, levels, 4) == 4
    assert fan_curve.duty_to_state(90.0, levels, 2) == 2   # 受 cdev_max 限制


def test_fan_controller_delegates_to_fan_curve():
    # 控制器方法与共享纯函数结果一致 (防止实现漂移)
    fc = _fc()
    fc._direction_up = True
    assert fc._calc_target_duty(50.0) == fan_curve.calc_target_duty(50.0, CURVE, 3.0, True)
    fc._direction_up = False
    assert fc._calc_target_duty(50.0) == fan_curve.calc_target_duty(50.0, CURVE, 3.0, False)


# ---- fan_sysfs 共享读取与探测 ----

def _write_sysfs(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(value), encoding="ascii")


def test_fan_sysfs_reads_temp_and_pwm(tmp_path):
    temp = tmp_path / "thermal_zone0" / "temp"
    _write_sysfs(temp, "47800")
    assert fan_sysfs.read_temp(str(temp)) == pytest.approx(47.8)

    pwm_root = tmp_path / "pwm"
    pwm = pwm_root / "pwmchip22" / "pwm5"
    _write_sysfs(pwm / "duty_cycle", "3000")
    _write_sysfs(pwm / "period", "10000")
    _write_sysfs(pwm / "enable", "1")
    assert fan_sysfs.read_pwm_duty(22, 5, str(pwm_root)) == pytest.approx(30.0)
    assert fan_sysfs.read_pwm_enabled(22, 5, str(pwm_root)) is True


def test_fan_sysfs_finds_thermal_nodes(tmp_path):
    thermal_root = tmp_path / "thermal"
    _write_sysfs(thermal_root / "thermal_zone1" / "policy", "user_space")
    cdev = thermal_root / "cooling_device2"
    _write_sysfs(cdev / "type", "pwm-fan")
    _write_sysfs(cdev / "max_state", "4")
    _write_sysfs(cdev / "cur_state", "2")

    policy = fan_sysfs.find_thermal_policy(str(thermal_root))
    assert policy == str(thermal_root / "thermal_zone1" / "policy")
    assert fan_sysfs.read_thermal_governor(str(thermal_root)) == "user_space"
    assert fan_sysfs.find_pwm_fan_cdev(str(thermal_root)) == (
        str(cdev / "cur_state"), 4,
    )
    assert fan_sysfs.read_cooling_state(str(thermal_root)) == 2


def test_fan_sysfs_init_pwm_enforces_configured_period(tmp_path):
    """回归(2026-08-25): init_pwm 不得采用内核已有 period。

    内核默认可能是极低频(本板 pwm5 实测 652629333ns≈1.5Hz), 会导致风扇
    低占空比起不来(实测只在 ~30% 才转)。必须强制写配置 period(10000ns)。
    """
    pwm_root = tmp_path / "pwm"
    chip = pwm_root / "pwmchip22"
    pwm = chip / "pwm5"
    _write_sysfs(pwm / "period", "652629333")  # 模拟内核默认低频 period

    fs = fan_sysfs.FanSysfs(22, 5, period_ns=10000, max_duty=9999)
    assert fs.init_pwm(22, pwm_root=str(pwm_root)) is True

    # 配置 period 被强制写入, 而非采用内核的 652629333
    assert (pwm / "period").read_text(encoding="ascii").strip() == "10000"
    assert fs.period_ns == 10000
    assert fs.max_duty == 9999
    # 初始化副作用: duty 归零、PWM 使能
    assert (pwm / "duty_cycle").read_text(encoding="ascii").strip() == "0"
    assert (pwm / "enable").read_text(encoding="ascii").strip() == "1"


def test_fan_sysfs_init_pwm_keeps_existing_matching_period(tmp_path):
    """内核 period 已等于配置值时不重复写, 直接采用 (无副作用回写)。"""
    pwm_root = tmp_path / "pwm"
    pwm = pwm_root / "pwmchip22" / "pwm5"
    _write_sysfs(pwm / "period", "10000")

    fs = fan_sysfs.FanSysfs(22, 5, period_ns=10000, max_duty=9999)
    assert fs.init_pwm(22, pwm_root=str(pwm_root)) is True
    assert fs.period_ns == 10000
    assert fs.max_duty == 9999


# ---- 抗抖动 (2026-08-12, OBS-02): 死区 / 最小保持 / 方向死区 / 启停回差 ----

def test_duty_outside_dead_band_pure():
    # 纯函数: 目标与已应用占空比差 ≥ 死区才认为需要更新
    assert fan_curve.duty_outside_dead_band(0.0, 35.0, 8.0) is True
    assert fan_curve.duty_outside_dead_band(35.0, 30.0, 8.0) is False   # 差5 < 8
    assert fan_curve.duty_outside_dead_band(35.0, 44.0, 8.0) is True    # 差9 >= 8
    assert fan_curve.duty_outside_dead_band(35.0, 27.1, 8.0) is False   # 差7.9 < 8
    assert fan_curve.duty_outside_dead_band(35.0, 27.0, 8.0) is True    # 差8 >= 8


def test_should_update_applied_dead_band_and_hold():
    fc = _fc()
    fc._mode = "pwm"
    fc._current_duty_pct = 35.0   # 已应用 35%
    # 目标 30% 与已应用差 5 < 死区 8 → 不更新, 保持计数清零
    assert fc._should_update_applied(30.0) is False
    assert fc._pending_samples == 0
    # 目标 44% 差 9 >= 死区 → 第一周期只计数, 不足保持期
    assert fc._should_update_applied(44.0) is False
    assert fc._pending_samples == 1
    # 第二周期目标仍 44% → 达到保持期 → 应用并清零
    assert fc._should_update_applied(44.0) is True
    assert fc._pending_samples == 0


def test_should_update_applied_single_spike_rejected():
    # 单周期温度尖峰: 90% 只出现一次, 下周期回 30% → 计数被清零, 永不应用
    fc = _fc()
    fc._mode = "pwm"
    fc._current_duty_pct = 35.0
    assert fc._should_update_applied(90.0) is False
    assert fc._pending_samples == 1
    assert fc._should_update_applied(30.0) is False
    assert fc._pending_samples == 0


def test_should_update_applied_starts_fan_from_zero():
    # 开机已应用 0%, 目标持续 35% (真实升温): 两周期后应用
    fc = _fc()
    fc._mode = "pwm"
    fc._current_duty_pct = 0.0
    assert fc._should_update_applied(35.0) is False
    assert fc._should_update_applied(35.0) is True


def test_resolve_pwm_output_min_effective_and_stop_hysteresis():
    fc = _fc()  # min_effective_duty=30, start_stop_hysteresis=8
    fc._current_duty_pct = 0.0
    # 已停转且目标 < 最低有效 → 保持停转
    assert fc._resolve_pwm_output(25.0) == 0.0
    # 在转 (35%), 目标 28% 未低于 30-8=22 → 保持最低有效 30%
    fc._current_duty_pct = 35.0
    assert fc._resolve_pwm_output(28.0) == 30.0
    # 目标 20% < 22% → 停转
    assert fc._resolve_pwm_output(20.0) == 0.0
    # 目标 ≥ 最低有效 → 原样 (取大)
    assert fc._resolve_pwm_output(45.0) == 45.0


def test_update_direction_dead_band_ignores_noise():
    fc = _fc()
    fc._temp_direction_dead_band = 0.5
    fc._direction_up = True
    fc._last_temp = 47.7
    # ±0.2°C 噪声不翻转方向 (实机 47~48°C 抖动场景)
    fc._update_direction(47.9)
    assert fc._direction_up is True
    fc._update_direction(47.6)
    assert fc._direction_up is True
    # 超过 0.5°C 才翻转
    fc._update_direction(48.3)
    assert fc._direction_up is True
    fc._update_direction(47.5)
    assert fc._direction_up is False
    fc._update_direction(47.7)
    assert fc._direction_up is False
