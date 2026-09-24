"""风扇相关 sysfs 的无状态读取/探测 + 有状态操作层 (FanSysfs)。

无状态函数: read_temp / find_thermal_policy / find_pwm_fan_cdev 等, 供
FanController 与 fan_monitor 共享。
有状态类 FanSysfs: 封装"解绑→初始化→写入→还原"多步内核接口操作,
FanController 只关心温控策略, 内核接口细节全部在此 (2026-08-18 拆分)。
"""

import logging
import os
import time
from typing import List, Optional, Tuple

logger = logging.getLogger("clawbox.fan.sysfs")

THERMAL_ROOT = "/sys/class/thermal"
PWM_ROOT = "/sys/class/pwm"

# 内核 cooling-levels 对应的 duty 值 (从设备树提取, 单位: PWM duty raw value / 255)
COOLING_LEVELS = [1, 120, 150, 200, 250]  # 5 档
# 内核 PWM duty 满量程 (raw value 0~255)
PWM_FULL_SCALE = 255.0
# 导出 PWM 通道后等待内核生成节点 (sysfs 异步, 实测需 ~150ms)
_EXPORT_SETTLE_S = 0.15
# 解绑 pwm-fan 驱动后等待内核释放 (避免立即初始化冲突)
_UNBIND_SETTLE_S = 0.3


class TempSensor:
    """可注入的温度传感器（生产环境读 sysfs，测试可 Mock）。接口: read() -> float"""

    def __init__(self, path: str) -> None:
        self.path = path

    def read(self) -> float:
        return read_temp(self.path)


def read_temp(path: str) -> float:
    """读取毫摄氏度 sysfs 节点并返回摄氏度。

    保留 OSError/ValueError 给调用方决定日志与降级策略。
    """
    with open(path, "r") as f:
        return int(f.read().strip()) / 1000.0


def pwm_channel_path(chip: int, channel: int, pwm_root: str = PWM_ROOT) -> str:
    return os.path.join(pwm_root, f"pwmchip{chip}", f"pwm{channel}")


def read_pwm_duty(chip: int, channel: int, pwm_root: str = PWM_ROOT) -> float:
    """读取 PWM 占空比；节点缺失或内容无效时抛出预期异常。"""
    path = pwm_channel_path(chip, channel, pwm_root)
    with open(os.path.join(path, "duty_cycle"), "r") as f:
        duty_ns = int(f.read().strip())
    with open(os.path.join(path, "period"), "r") as f:
        period_ns = int(f.read().strip())
    return duty_ns / period_ns * 100.0 if period_ns > 0 else 0.0


def read_pwm_enabled(chip: int, channel: int, pwm_root: str = PWM_ROOT) -> bool:
    path = pwm_channel_path(chip, channel, pwm_root)
    with open(os.path.join(path, "enable"), "r") as f:
        return f.read().strip() == "1"


def find_thermal_policy(
    thermal_root: str = THERMAL_ROOT,
    max_devices: int = 5,
) -> str:
    """返回第一个存在的 thermal zone policy 路径。"""
    for index in range(max_devices):
        path = os.path.join(thermal_root, f"thermal_zone{index}", "policy")
        if os.path.exists(path):
            return path
    return ""


def read_thermal_governor(
    thermal_root: str = THERMAL_ROOT,
    max_devices: int = 5,
) -> str:
    """读取第一个可读的 thermal governor，找不到时返回问号。"""
    for index in range(max_devices):
        path = os.path.join(thermal_root, f"thermal_zone{index}", "policy")
        try:
            with open(path, "r") as f:
                return f.read().strip()
        except OSError:
            continue
    return "?"


def find_pwm_fan_cdev(
    thermal_root: str = THERMAL_ROOT,
    max_devices: int = 5,
) -> Optional[Tuple[str, Optional[int]]]:
    """返回 pwm-fan 的 cur_state 路径和可选 max_state。"""
    for index in range(max_devices):
        path = os.path.join(thermal_root, f"cooling_device{index}")
        try:
            with open(os.path.join(path, "type"), "r") as f:
                if "pwm-fan" not in f.read():
                    continue
        except OSError:
            continue

        max_state = None
        try:
            with open(os.path.join(path, "max_state"), "r") as f:
                max_state = int(f.read().strip())
        except (OSError, ValueError):
            pass
        return os.path.join(path, "cur_state"), max_state
    return None


def read_cooling_state(
    thermal_root: str = THERMAL_ROOT,
    max_devices: int = 5,
) -> Optional[int]:
    found = find_pwm_fan_cdev(thermal_root, max_devices)
    if not found:
        return None
    try:
        with open(found[0], "r") as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


class FanSysfs:
    """pwm-fan 的 sysfs 操作层 (无控制策略, 只做内核接口读写)。

    为什么独立成类: FanController 的初始化/清理涉及"解绑→初始化→还原"
    多步内核状态 (被解绑设备、原 governor), 这些状态与 sysfs 路径强绑定。
    抽到本类后 FanController 只关心温控策略, 内核接口细节全部在此
    (2026-08-18 拆分, 行为与原 FanController 内联版完全一致)。
    """

    def __init__(self, pwm_chip: int, pwm_channel: int,
                 period_ns: int, max_duty: int) -> None:
        self.pwm_chip = pwm_chip
        self.pwm_channel = pwm_channel
        self.period_ns = period_ns
        self.max_duty = max_duty
        # 探测/初始化后填充
        self.pwm_path = ""
        self.tz_policy = ""
        self.cdev_state = ""
        self.cdev_max = 4
        self.cdev_levels = COOLING_LEVELS
        # 还原记录 (cleanup 时交还内核, 2026-08-14 审查 P1-1)
        self.unbound_entries: List[str] = []
        self.previous_governor = ""

    def pwm_chip_exists(self, chip: int) -> bool:
        return os.path.exists(f"/sys/class/pwm/pwmchip{chip}")

    def detect_pwm_chip(self) -> int:
        """自动探测风扇所在的 PWM 芯片 (特征: npwm=8, mcu_pwm0 是 8 通道)。"""
        pwm_root = "/sys/class/pwm"
        if not os.path.isdir(pwm_root):
            logger.debug("PWM sysfs 目录不存在")
            return -1

        for entry in sorted(os.listdir(pwm_root)):
            if not entry.startswith("pwmchip"):
                continue
            chip_num = int(entry.replace("pwmchip", ""))
            npwm_file = os.path.join(pwm_root, entry, "npwm")
            try:
                with open(npwm_file, "r") as f:
                    if int(f.read().strip()) == 8:
                        # 检查 channel 是否可访问
                        pwm_dir = os.path.join(
                            pwm_root, entry, f"pwm{self.pwm_channel}"
                        )
                        if os.path.exists(pwm_dir):
                            return chip_num
                        # 尝试导出
                        export_file = os.path.join(pwm_root, entry, "export")
                        try:
                            with open(export_file, "w") as f:
                                f.write(str(self.pwm_channel))
                            time.sleep(_EXPORT_SETTLE_S)
                            if os.path.exists(pwm_dir):
                                return chip_num
                        except OSError:
                            pass
            except (OSError, ValueError):
                continue
        return -1

    def unbind_pwm_fan(self) -> bool:
        """尝试解绑内核 pwm-fan 驱动 (释放 PWM 供用户态直接控制)。"""
        driver_path = "/sys/bus/platform/drivers/pwm-fan"
        if not os.path.isdir(driver_path):
            logger.info("pwm-fan 驱动目录不存在（内核无 pwm-fan 平台驱动）")
            return False

        entries = [e for e in os.listdir(driver_path)
                   if e not in ("bind", "unbind", "uevent", "module")]
        if not entries:
            logger.info("pwm-fan 驱动目录存在但无绑定设备")
            return False

        for entry in entries:
            unbind_file = os.path.join(driver_path, "unbind")
            try:
                with open(unbind_file, "w") as f:
                    f.write(entry)
                # 记录被解绑的设备, restore() 时重新绑定 (2026-08-14 审查 P1-1)
                self.unbound_entries.append(entry)
                logger.info(f"已解绑内核 pwm-fan: {entry}")
                time.sleep(_UNBIND_SETTLE_S)
                return True
            except OSError as e:
                logger.warning(f"解绑 pwm-fan 失败 ({entry}): {e}")

        return False

    def init_pwm(self, chip: int, pwm_root: str = "/sys/class/pwm") -> bool:
        """直接通过 sysfs 初始化 PWM (无内核驱动冲突时的简单路径)。"""
        chip_path = os.path.join(pwm_root, f"pwmchip{chip}")
        self.pwm_path = os.path.join(chip_path, f"pwm{self.pwm_channel}")

        try:
            # 导出通道
            if not os.path.exists(self.pwm_path):
                export_file = os.path.join(chip_path, "export")
                with open(export_file, "w") as f:
                    f.write(str(self.pwm_channel))
                time.sleep(_EXPORT_SETTLE_S)

            if not os.path.exists(self.pwm_path):
                return False

            # 读/设 period: 始终强制写配置 period (FAN_PWM_PERIOD_NS=10000/100kHz)。
            # 不能"内核已有非零值就直接用"——内核默认可能是极低频率(本板实测
            # 652629333ns≈1.5Hz), 低频 PWM 让风扇低占空比起不来(实测只在 ~30% 才转)。
            # 2026-08-25 修复。
            period_file = os.path.join(self.pwm_path, "period")
            try:
                with open(period_file, "r") as f:
                    existing = int(f.read().strip())
                if existing != self.period_ns:
                    try:
                        with open(period_file, "w") as f:
                            f.write(str(self.period_ns))
                        existing = self.period_ns
                    except OSError as e:
                        # 内核拒绝写入时回退内核值, 保证风扇仍可控(只是频率非理想)
                        logger.warning(
                            f"PWM period 写入 {self.period_ns}ns 失败, 沿用内核 {existing}ns: {e}"
                        )
                self.period_ns = existing
                self.max_duty = existing - 1
            except OSError:
                return False

            # 设 duty=0
            duty_file = os.path.join(self.pwm_path, "duty_cycle")
            try:
                with open(duty_file, "w") as f:
                    f.write("0")
            except OSError:
                return False

            # 启用 PWM
            enable_file = os.path.join(self.pwm_path, "enable")
            try:
                with open(enable_file, "w") as f:
                    f.write("1")
            except OSError:
                return False

            return True

        except Exception as e:
            logger.warning(
                f"PWM初始化细节失败 (pwmchip{chip}/pwm{self.pwm_channel}): {e}"
            )
            return False

    def find_thermal_paths(self) -> bool:
        """查找 thermal_zone policy 和 pwm-fan cooling_device。"""
        self.tz_policy = find_thermal_policy()

        if not self.tz_policy:
            logger.debug("未找到可写的 thermal_zone policy")
            return False

        found = find_pwm_fan_cdev()
        if found:
            self.cdev_state, max_state = found
            if max_state is not None:
                self.cdev_max = max_state
            logger.info(f"找到 pwm-fan cooling device: max_state={self.cdev_max}")
            return True

        logger.debug("未找到 pwm-fan cooling_device")
        return False

    def set_userspace_governor(self) -> bool:
        """设置 thermal governor 为 user_space (停止内核自动调速)。"""
        if not self.tz_policy:
            return False
        try:
            with open(self.tz_policy, "r") as f:
                current = f.read().strip()
            if current == "user_space":
                logger.info("thermal governor 已是 user_space")
                return True
            # 记录原 governor, restore() 时还原 (2026-08-14 审查 P1-1)
            self.previous_governor = current
            with open(self.tz_policy, "w") as f:
                f.write("user_space")
            with open(self.tz_policy, "r") as f:
                if f.read().strip() == "user_space":
                    logger.info(
                        "thermal governor 已设置为 user_space（内核不再自动调速）"
                    )
                    return True
            logger.warning(f"thermal governor 设置失败，当前: {current}")
            return False
        except OSError as e:
            logger.warning(f"设置 thermal governor 失败: {e}")
            return False

    def write_cur_state(self, state: int) -> bool:
        """写入 cooling_device cur_state (带 max 钳制)。"""
        if not self.cdev_state:
            return False
        state = max(0, min(self.cdev_max, state))
        with open(self.cdev_state, "w") as f:
            f.write(str(state))
        return True

    def write_pwm_duty_ns(self, duty_ns: int) -> None:
        """写入 PWM duty_cycle (节点消失抛 FileNotFoundError)。"""
        duty_file = os.path.join(self.pwm_path, "duty_cycle")
        if not os.path.exists(duty_file):
            raise FileNotFoundError(f"PWM节点消失: {duty_file}")
        with open(duty_file, "w") as f:
            f.write(str(duty_ns))

    def set_enable(self, on: bool) -> bool:
        """写 PWM enable 节点。"""
        enable_file = os.path.join(self.pwm_path, "enable")
        if not os.path.exists(enable_file):
            return False
        try:
            with open(enable_file, "w") as f:
                f.write("1" if on else "0")
            return True
        except OSError:
            return False

    def unexport(self) -> bool:
        """释放 PWM 通道 (unexport)。"""
        unexport_file = os.path.join(
            os.path.dirname(self.pwm_path), "unexport"
        )
        if not os.path.exists(unexport_file):
            return False
        try:
            with open(unexport_file, "w") as f:
                f.write(str(self.pwm_channel))
            return True
        except OSError:
            return False

    def restore(self) -> None:
        """还原被改写的内核状态, 避免停守护进程后风扇失控 (2026-08-14 审查 P1-1):
          1) thermal governor 改回原值 (仅当本进程曾改为 user_space)
          2) 重新绑定被解绑的 pwm-fan 设备, 交还内核散热调速
        """
        if self.previous_governor and self.tz_policy:
            try:
                with open(self.tz_policy, "w") as f:
                    f.write(self.previous_governor)
                logger.info(f"已还原 thermal governor: {self.previous_governor}")
            except OSError as e:
                logger.warning(f"还原 thermal governor 失败: {e}")
        for entry in self.unbound_entries:
            bind_file = "/sys/bus/platform/drivers/pwm-fan/bind"
            try:
                with open(bind_file, "w") as f:
                    f.write(entry)
                logger.info(f"已重新绑定内核 pwm-fan: {entry}")
            except OSError as e:
                logger.warning(f"重新绑定 pwm-fan 失败 ({entry}): {e}")
        self.unbound_entries = []
