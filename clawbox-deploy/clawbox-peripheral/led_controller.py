"""
LED 控制器 —— 管理三色 LED 指示灯
鲁棒性: 每个 LED 独立初始化，某个缺失不影响其他
"""

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger("clawbox.led")

# 尝试导入 gpiod
try:
    import gpiod
    HAS_GPIOD = True
except ImportError:
    HAS_GPIOD = False
    logger.warning("gpiod 未安装，LED 功能不可用。安装: pip3 install gpiod")


class LedController:
    """三色 LED 控制器 (红=开机, 黄=热点, 绿=WiFi)"""

    def __init__(self, led_configs: Dict[str, Dict[str, Any]]):
        """
        Args:
            led_configs: LED 配置字典，格式:
                {"name": {"chip": "gpiochipX", "line": N, "name": "显示名"}}
        """
        self._leds: Dict[str, Dict[str, Any]] = {}
        self._chips: Dict[str, Any] = {}  # 缓存已打开的 gpiochip

        if not HAS_GPIOD:
            for name in led_configs:
                self._leds[name] = {"available": False, "reason": "gpiod 未安装"}
            return

        for led_name, cfg in led_configs.items():
            self._init_led(led_name, cfg)

    def _init_led(self, name: str, cfg: Dict[str, Any]) -> None:
        """初始化单个 LED，失败不影响其他"""
        chip_name = cfg["chip"]
        line_num = cfg["line"]
        display_name = cfg.get("name", name)

        try:
            # 复用已打开的 chip
            if chip_name not in self._chips:
                self._chips[chip_name] = gpiod.Chip(chip_name)

            chip = self._chips[chip_name]
            line = chip.get_line(line_num)
            line.request(
                consumer=f"clawbox-led-{name}",
                type=gpiod.LINE_REQ_DIR_OUT,
                default_vals=[0],  # 默认熄灭
            )

            self._leds[name] = {
                "chip": chip,
                "line": line,
                "available": True,
                "name": display_name,
                "state": False,
            }
            logger.info(f"LED [{display_name}] 初始化成功: {chip_name}:line{line_num}")

        except Exception as e:
            self._leds[name] = {
                "available": False,
                "reason": str(e),
                "name": display_name,
            }
            logger.warning(f"LED [{display_name}] 初始化失败 ({chip_name}:line{line_num}): {e}")

    # ---- 公开 API ----

    def set_power(self, on: bool) -> None:
        """设置开机指示灯 (红灯)"""
        self._set("power", on)

    def set_hotspot(self, on: bool) -> None:
        """设置热点指示灯 (黄灯)"""
        self._set("hotspot", on)

    def set_wifi(self, on: bool) -> None:
        """设置 WiFi 连接指示灯 (绿灯)"""
        self._set("wifi", on)

    def update_status(self, *, power: Optional[bool] = None,
                      hotspot: Optional[bool] = None,
                      wifi: Optional[bool] = None) -> None:
        """批量更新 LED 状态"""
        if power is not None:
            self.set_power(power)
        if hotspot is not None:
            self.set_hotspot(hotspot)
        if wifi is not None:
            self.set_wifi(wifi)

    def all_off(self) -> None:
        """熄灭所有 LED"""
        for name in self._leds:
            self._set(name, False)

    def get_state(self) -> Dict[str, bool]:
        """返回所有 LED 当前状态"""
        return {
            name: info.get("state", False)
            for name, info in self._leds.items()
            if info.get("available")
        }

    def cleanup(self) -> None:
        """释放所有 GPIO 资源"""
        for name, info in self._leds.items():
            if info.get("available"):
                try:
                    info["line"].set_value(0)
                    info["line"].release()
                except OSError as e:
                    logger.debug(f"释放 LED [{name}] 时出错: {e}")

        for chip in self._chips.values():
            try:
                chip.close()
            except OSError:
                pass

        self._leds.clear()
        self._chips.clear()
        logger.info("LED 控制器已清理")

    # ---- 内部方法 ----

    def _set(self, name: str, on: bool) -> None:
        """设置单个 LED"""
        info = self._leds.get(name)
        if not info:
            return

        if not info.get("available"):
            return

        # 状态未变化时跳过 sysfs 写入: 主循环每 ~30ms 同步一次 LED,
        # 反复 set_value 是无谓的内核往返 (2026-08-14 审查 P2-2)
        if info.get("state") == on:
            return

        try:
            info["line"].set_value(1 if on else 0)
            info["state"] = on
        except OSError as e:
            logger.error(f"设置 LED [{name}] 失败: {e}")
            info["available"] = False  # 标记为不可用，避免反复报错
