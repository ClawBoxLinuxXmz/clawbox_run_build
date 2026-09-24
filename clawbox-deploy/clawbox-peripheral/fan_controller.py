"""
风扇温控控制器 —— 根据 CPU 温度自动调节 PWM 风扇转速
========================================================
控制策略（按优先级）：
  1. 接管内核 thermal governor → 直接控制 cooling_device/cur_state
  2. 如能解绑内核驱动 → 直接 sysfs PWM（精细调速）
  3. 都不行 → 仅温度监控，风扇由内核控制

鲁棒性: 任何初始化失败都不影响守护进程其他部分
运行时容错: 风扇意外断开/损坏不会拖垮进程
"""

import logging
import threading
import time
from typing import List, Optional, Tuple

from fan_curve import (
    calc_target_duty as _curve_target_duty,
)
from fan_curve import (
    duty_outside_dead_band as _duty_outside_dead_band,
)
from fan_curve import (
    duty_to_state as _map_duty_to_state,
)
from fan_sysfs import PWM_FULL_SCALE, FanSysfs, TempSensor

logger = logging.getLogger("clawbox.fan")

# 连续错误超过此阈值后降低日志频率
_MAX_CONSECUTIVE_ERRORS_BEFORE_SILENCE = 3
# 恢复尝试间隔（秒）
_RECOVERY_INTERVAL = 30.0
# 解绑内核 pwm-fan 驱动后等待内核完全释放 (避免立即初始化冲突)
_UNBIND_RELEASE_S = 0.5
# 占空比写入/日志去重阈值(%): 变化小于此值视为未变, 避免无意义写入与刷屏
_DUTY_CHANGE_EPSILON = 0.5
# 判断风扇已停转的占空比阈值(%): 低于此值视为停转 (启停回差判定用)
_STOPPED_DUTY_THRESHOLD = 1.0
# 温度方向判定死区(°C): 温度变化须超过此值才翻转升/降温方向。
# 传感器噪声 ±0.2°C, 若不加死区方向会每周期翻转 → 目标占空比在滞回上下
# 之间反复横跳 (实机 47~48°C 时 30%↔36%, 2026-08-12 审计 OBS-02)。
_DEFAULT_TEMP_DIRECTION_DEAD_BAND = 0.5
# 占空比死区(%): 目标与已应用占空比相差小于此值不变速, 吸收温度噪声抖动
_DEFAULT_DUTY_DEAD_BAND = 8.0
# 最小保持采样数: 目标须持续超出死区 N 个控制周期才应用, 拒绝单点温度尖峰
_DEFAULT_MIN_HOLD_SAMPLES = 2
# 日志心跳间隔(秒): 实际占空比不变时每 N 秒打一条存活日志, 防日志泛滥
_DEFAULT_LOG_HEARTBEAT_INTERVAL = 300.0


class FanController:
    """PWM 风扇温控器（优先使用 thermal 框架，回退到直接 PWM）"""

    def __init__(
        self,
        pwm_chip: int = 0,
        pwm_channel: int = 5,
        period_ns: int = 10000,
        max_duty: int = 9999,
        temp_sensor: str = "/sys/class/thermal/thermal_zone0/temp",
        temp_sensor_obj: Optional[TempSensor] = None,
        speed_curve: Optional[List[Tuple[float, float]]] = None,
        hysteresis: float = 3.0,
        check_interval: float = 3.0,
        min_effective_duty: float = 25.0,
        start_stop_hysteresis: float = 8.0,
        duty_dead_band: float = _DEFAULT_DUTY_DEAD_BAND,
        min_hold_samples: int = _DEFAULT_MIN_HOLD_SAMPLES,
        temp_direction_dead_band: float = _DEFAULT_TEMP_DIRECTION_DEAD_BAND,
        log_heartbeat_interval: float = _DEFAULT_LOG_HEARTBEAT_INTERVAL,
    ):
        self._temp_sensor = temp_sensor
        self._sensor = temp_sensor_obj or TempSensor(temp_sensor)
        self._speed_curve = speed_curve or [
            (45, 0), (55, 30), (65, 60), (75, 100)
        ]
        self._hysteresis = hysteresis
        self._check_interval = check_interval
        self._min_effective_duty = min_effective_duty
        self._start_stop_hysteresis = start_stop_hysteresis
        # 抗抖动参数 (2026-08-12, OBS-02): 死区 + 最小保持时间 + 方向死区
        self._duty_dead_band = duty_dead_band
        self._min_hold_samples = max(1, int(min_hold_samples))
        self._temp_direction_dead_band = temp_direction_dead_band
        self._log_heartbeat_interval = log_heartbeat_interval

        # 运行时状态
        self._available = False
        self._mode = ""                # "thermal" | "pwm" | ""
        self._reason = ""
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._current_duty_pct = -1
        self._last_temp = 0.0
        self._direction_up = True
        # 目标持续超出死区的采样计数 (最小保持时间用)
        self._pending_samples = 0

        # 容错计数器
        self._error_count = 0
        self._disabled_at = 0.0
        self._temp_error_count = 0

        # sysfs 操作层: 封装"解绑→初始化→写入→还原"内核接口,
        # 本类只保留温控策略 (2026-08-18 拆分, 见 fan_sysfs.FanSysfs)
        self._sysfs = FanSysfs(pwm_chip, pwm_channel, period_ns, max_duty)

        # 初始化
        self._init_control()

    # ================================================================
    # 初始化 —— 三阶段策略 (sysfs 探测/写入细节在 fan_sysfs.FanSysfs)
    # ================================================================

    def _init_control(self) -> None:
        """
        初始化风扇控制。
        策略：
          1. 解绑内核 pwm-fan 驱动 → 释放 PWM 通道
          2. 直接 sysfs PWM（精细调速，之前正常工作的模式）
          3. 若 PWM 仍被占用 → thermal cooling device 回退
          4. 若以上都不行 → 仅温度监控
        """
        # ── 自动探测正确的 PWM 芯片 ──
        chip = self._sysfs.pwm_chip
        if not self._sysfs.pwm_chip_exists(chip):
            chip = self._sysfs.detect_pwm_chip()
            if chip >= 0:
                logger.info(f"自动探测到风扇PWM: pwmchip{chip}")
            else:
                self._available = False
                self._reason = (
                    f"未找到风扇PWM控制器 (尝试过 pwmchip{self._sysfs.pwm_chip})"
                )
                logger.warning(f"{self._reason}，仅监控温度")
                return

        actual_chip = chip

        # ── 方案1: 解绑内核驱动 → 直接 PWM（恢复 7.29 正常工作的模式）──
        if self._sysfs.unbind_pwm_fan():
            logger.info("已解绑内核 pwm-fan 驱动，释放 PWM 通道供用户态使用")
            time.sleep(_UNBIND_RELEASE_S)  # 等内核完全释放

        if self._sysfs.init_pwm(actual_chip):
            self._mode = "pwm"
            self._available = True
            self._reason = ""
            self._current_duty_pct = 0.0
            logger.info(
                f"风扇温控已就绪 (直接PWM: pwmchip{actual_chip}"
                f"/pwm{self._sysfs.pwm_channel})"
            )
            return

        # ── 方案2: 直接 PWM 仍失败 → thermal cooling device 回退 ──
        logger.info("直接PWM不可用，尝试 thermal cooling device 回退方案...")
        if self._sysfs.find_thermal_paths():
            if self._sysfs.set_userspace_governor():
                self._mode = "thermal"
                self._available = True
                self._reason = ""
                logger.info(
                    f"风扇温控已就绪 (thermal cooling device, "
                    f"max_state={self._sysfs.cdev_max})"
                )
                return
            else:
                logger.warning("thermal governor 切换失败，无法接管风扇控制")
        else:
            logger.warning("未找到 pwm-fan cooling device，无法回退")

        self._available = False
        self._reason = (
            f"PWM初始化失败 (pwmchip{actual_chip}/pwm{self._sysfs.pwm_channel})"
        )
        logger.warning(f"{self._reason}，仅监控温度")
        self._disabled_at = time.monotonic()

    # ================================================================
    # 风扇控制
    # ================================================================

    def _duty_to_state(self, duty_pct: float) -> int:
        """将占空比百分比映射到 cooling_device cur_state。

        kernel cooling-levels: [1, 120, 150, 200, 250] (/255)
        → ~[0.4%, 47%, 59%, 78%, 98%]; 用较大 offset(18) 确保风扇在合理温度启动。
        计算逻辑在 fan_curve.duty_to_state (与 fan_monitor 共享)。
        """
        return _map_duty_to_state(
            duty_pct, self._sysfs.cdev_levels, self._sysfs.cdev_max
        )

    def _write_cur_state(self, state: int) -> bool:
        """写入 cooling_device cur_state (带容错与日志节流)。"""
        if not self._sysfs.cdev_state:
            return False
        try:
            return self._sysfs.write_cur_state(state)
        except OSError as e:
            self._error_count += 1
            if self._error_count <= _MAX_CONSECUTIVE_ERRORS_BEFORE_SILENCE:
                logger.warning(f"写入 cur_state 失败: {e}")
            return False

    def _write_pwm_duty(self, duty_pct: float) -> bool:
        """直接写入 PWM duty_cycle (带容错与日志节流)。"""
        if not self._sysfs.pwm_path:
            return False
        pct = max(0.0, min(100.0, duty_pct))
        if abs(pct - self._current_duty_pct) < _DUTY_CHANGE_EPSILON:
            return True

        duty_ns = int(self._sysfs.max_duty * pct / 100.0)
        duty_ns = max(0, min(self._sysfs.max_duty, duty_ns))

        try:
            self._sysfs.write_pwm_duty_ns(duty_ns)
            self._current_duty_pct = pct
            self._error_count = 0
            return True
        except OSError as e:
            self._error_count += 1
            if self._error_count <= _MAX_CONSECUTIVE_ERRORS_BEFORE_SILENCE:
                logger.warning(f"PWM写入失败: {e}")
            elif self._error_count == _MAX_CONSECUTIVE_ERRORS_BEFORE_SILENCE + 1:
                logger.warning("PWM持续写入失败，后续错误静默")
            self._available = False
            self._reason = str(e)
            return False

    def _should_update_applied(self, target_pct: float) -> bool:
        """死区 + 最小保持时间判定: 目标须持续超出已应用占空比死区 N 个采样周期。

        返回 True 表示本次应把目标写到硬件, 并清零保持计数。
        原因: 温度噪声让目标在死区内外反复进出, 若只看单周期差值会每 3s 变速
        (实机 47~48°C 时 30%↔36%, 2026-08-12 审计 OBS-02), 保持期要求目标
        "持续偏离"才动, 单点温度尖峰被拒绝。
        """
        if not _duty_outside_dead_band(
                self._current_duty_pct, target_pct, self._duty_dead_band):
            self._pending_samples = 0
            return False
        self._pending_samples += 1
        if self._pending_samples >= self._min_hold_samples:
            self._pending_samples = 0
            return True
        return False

    def _resolve_pwm_output(self, target_pct: float) -> float:
        """目标占空比 → 实际写入占空比 (最低有效占空比 + 启停回差)。

        低于最低有效占空比时: 已停转则保持停转; 在转则须再降
        start_stop_hysteresis 才停 (防止启停抖动)。原实现硬编码 "-10",
        与配置的 _start_stop_hysteresis=8 不一致 → 改用配置值 (2026-08-12)。
        """
        if target_pct < self._min_effective_duty:
            if self._current_duty_pct < _STOPPED_DUTY_THRESHOLD:
                return 0.0
            if target_pct < self._min_effective_duty - self._start_stop_hysteresis:
                return 0.0
            return self._min_effective_duty
        return max(target_pct, self._min_effective_duty)

    def _apply_duty(self, duty_pct: float) -> None:
        """
        应用占空比 (先过死区 + 最小保持时间门控, 抑制温度噪声引起的档位抖动)。

        PWM 模式: 连续调速，带最低有效占空比和启停回差。
        Thermal 模式: 离散档位控制，直接映射目标 duty 到 cooling state。
        """
        if not self._should_update_applied(duty_pct):
            return

        if self._mode == "pwm":
            self._write_pwm_duty(self._resolve_pwm_output(duty_pct))

        elif self._mode == "thermal":
            # Thermal 离散档位：直接用原始目标 duty 映射
            # _calc_target_duty 已处理温度回滞，此处只需映射到 cooling state
            state = self._duty_to_state(duty_pct)
            self._write_cur_state(state)
            if state < len(self._sysfs.cdev_levels):
                self._current_duty_pct = (
                    self._sysfs.cdev_levels[state] / PWM_FULL_SCALE * 100
                )

    # ================================================================
    # 温度读取
    # ================================================================

    def _read_temp(self) -> Optional[float]:
        """读取 SoC 温度 (°C)"""
        try:
            temp_c = self._sensor.read()
            self._temp_error_count = 0
            return temp_c
        except FileNotFoundError:
            self._temp_error_count += 1
            if self._temp_error_count <= _MAX_CONSECUTIVE_ERRORS_BEFORE_SILENCE:
                logger.warning(f"温度传感器不存在: {self._temp_sensor}")
            return None
        except (ValueError, OSError) as e:
            self._temp_error_count += 1
            if self._temp_error_count <= _MAX_CONSECUTIVE_ERRORS_BEFORE_SILENCE:
                logger.warning(f"读取温度失败: {e}")
            return None
        except Exception as e:
            self._temp_error_count += 1
            if self._temp_error_count == 1:
                logger.error(f"读取温度非预期异常: {type(e).__name__}: {e}")
            return None

    # ================================================================
    # 温控逻辑
    # ================================================================

    def _calc_target_duty(self, temp_c: float) -> float:
        """根据温控曲线计算目标占空比（带滞回, 计算逻辑在 fan_curve）。"""
        return _curve_target_duty(
            temp_c, self._speed_curve, self._hysteresis, self._direction_up,
        )

    def _try_recover(self) -> None:
        """尝试恢复风扇控制（每 30 秒最多尝试一次）"""
        if self._available:
            return
        if self._disabled_at == 0.0:
            self._disabled_at = time.monotonic()
            return
        if time.monotonic() - self._disabled_at < _RECOVERY_INTERVAL:
            return

        logger.info("尝试恢复风扇控制...")
        self._init_control()
        # 无论成功与否都重置计时器，避免失败后每次循环都重试
        self._disabled_at = time.monotonic()
        if self._available:
            logger.info("风扇控制已恢复")
        else:
            logger.debug(f"恢复未成功，{_RECOVERY_INTERVAL}秒后重试")

    def _update_direction(self, temp_c: float) -> None:
        """更新升温/降温方向 (带死区)。

        温度变化须超过 _temp_direction_dead_band 才翻转方向, 否则保持原方向。
        原因: 传感器噪声 ±0.2°C, 无死区时方向每周期翻转 → 目标在滞回上下
        反复横跳 (实机 47~48°C 时 30%↔36%, 2026-08-12 审计 OBS-02)。
        """
        if self._last_temp > 0:
            delta = temp_c - self._last_temp
            if delta > self._temp_direction_dead_band:
                self._direction_up = True
            elif delta < -self._temp_direction_dead_band:
                self._direction_up = False
        self._last_temp = temp_c

    def _control_loop(self) -> None:
        """后台线程: 定期检测温度 → 调节风扇"""
        logger.info(f"风扇温控线程启动 (模式: {self._mode or '仅监控'})")
        last_log_time = 0.0
        last_logged_duty = -1.0

        while self._running:
            try:
                temp = self._read_temp()
                if temp is None:
                    time.sleep(self._check_interval)
                    continue

                self._update_direction(temp)
                target_pct = self._calc_target_duty(temp)

                if self._available:
                    self._apply_duty(target_pct)
                else:
                    self._try_recover()

                # 日志去重: 仅当实际占空比变化或到达心跳间隔才打一条。
                # 原因: 温度噪声导致的"目标值抖动"不写日志, 否则 3s 一条把
                # 主日志刷成风扇流水账 (实机 400/400 行全是温度行, OBS-02)。
                now = time.monotonic()
                shown_duty = self._current_duty_pct if self._current_duty_pct >= 0.0 \
                    else target_pct
                if (abs(shown_duty - last_logged_duty) >= _DUTY_CHANGE_EPSILON
                        or now - last_log_time >= self._log_heartbeat_interval):
                    target_note = ""
                    if abs(target_pct - shown_duty) >= _DUTY_CHANGE_EPSILON:
                        target_note = f" (目标 {target_pct:.0f}%)"
                    status = ""
                    if not self._available:
                        status = f" [不可控: {self._reason[:40]}]"
                    elif self._mode == "thermal":
                        state = self._duty_to_state(target_pct)
                        status = f" [thermal state={state}/{self._sysfs.cdev_max}]"
                    logger.info(
                        f"CPU温度: {temp:.1f}°C → 风扇: {shown_duty:.0f}%"
                        f"{target_note} "
                        f"{'↑' if self._direction_up else '↓'}{status}"
                    )
                    last_logged_duty = shown_duty
                    last_log_time = now

            except Exception as e:
                logger.error(
                    f"风扇温控循环异常 (已捕获): {type(e).__name__}: {e}"
                )
                # 不在此处 sleep，由循环底部统一 sleep 避免异常路径双重延迟

            time.sleep(self._check_interval)

        logger.info("风扇温控线程退出")

    # ================================================================
    # 公开 API
    # ================================================================

    @property
    def available(self) -> bool:
        return self._available

    @property
    def mode(self) -> str:
        """控制模式: "pwm" | "thermal" | "" """
        return self._mode

    @property
    def reason(self) -> str:
        return self._reason if not self._available else ""

    @property
    def current_temp(self) -> float:
        return self._last_temp

    @property
    def current_duty_pct(self) -> float:
        return self._current_duty_pct

    @property
    def is_running(self) -> bool:
        return self._running

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._control_loop, daemon=True, name="fan-control"
        )
        self._thread.start()
        if self._available:
            logger.info(f"风扇温控已启动 (模式: {self._mode})")
        else:
            logger.info("温度监控已启动 (风扇不可控)")

    def stop(self) -> None:
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        logger.info("风扇温控已停止")

    def set_full_speed(self) -> None:
        if self._mode == "pwm":
            self._write_pwm_duty(100.0)
        elif self._mode == "thermal":
            self._write_cur_state(self._sysfs.cdev_max)

    def set_off(self) -> None:
        if self._mode == "pwm":
            self._write_pwm_duty(0.0)
        elif self._mode == "thermal":
            self._write_cur_state(0)

    def cleanup(self) -> None:
        self.stop()
        if self._mode == "pwm" and self._sysfs.pwm_path:
            self._sysfs.set_enable(False)
            # 释放 PWM 通道: 只关 enable 不 unexport 的话, 内核 pwm-fan 重新绑定时
            # 会报 Device or resource busy (2026-08-14 上板实测), 导致交还内核失败
            self._sysfs.unexport()
        # 还原被改写的内核状态, 避免停守护进程后风扇失控 (2026-08-14 审查 P1-1):
        #   1) thermal governor 改回原值 (仅当本进程曾改为 user_space)
        #   2) 重新绑定被解绑的 pwm-fan 设备, 交还内核散热调速
        self._sysfs.restore()
        logger.info("风扇控制器已清理")
