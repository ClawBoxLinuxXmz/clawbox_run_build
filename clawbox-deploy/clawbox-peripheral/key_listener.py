"""
按键监听器 —— 监听 4 个物理按键的按下/释放事件
鲁棒性: 每个按键独立初始化，支持去抖和长按检测
"""

import logging
import time
from typing import Any, Callable, Dict

logger = logging.getLogger("clawbox.key")

try:
    import gpiod
    HAS_GPIOD = True
except ImportError:
    HAS_GPIOD = False


class KeyListener:
    """
    按键事件监听器
    回调签名: callback(key_id: str, event: str)
        key_id: "k1" ~ "k4"
        event:  "press" - 短按（松手时触发，非按下瞬间）
                "long"  - 长按（按住超过阈值，仅 K4）
    """

    def __init__(self,
                 key_configs: Dict[str, Dict[str, Any]],
                 callback: Callable[[str, str], None],
                 debounce_ms: int = 80,
                 long_press_ms: int = 3000):
        """
        Args:
            key_configs: 按键配置
            callback: 事件回调函数
            debounce_ms: 去抖时间(毫秒)
            long_press_ms: 长按判定时间(毫秒)
        """
        self._callback = callback
        self._debounce_s = debounce_ms / 1000.0
        self._long_press_s = long_press_ms / 1000.0

        self._keys: Dict[str, Dict[str, Any]] = {}
        self._chips: Dict[str, Any] = {}

        if not HAS_GPIOD:
            logger.warning("gpiod 未安装，按键功能不可用")
            return

        for key_id, cfg in key_configs.items():
            self._init_key(key_id, cfg)

        # 记录哪些 key 可用
        available = [k for k, v in self._keys.items() if v.get("available")]
        if available:
            logger.info(f"按键初始化完成，可用: {available}")
        else:
            logger.warning("没有可用的按键")

    def _init_key(self, key_id: str, cfg: Dict[str, Any]) -> None:
        """初始化单个按键"""
        chip_name = cfg["chip"]
        line_num = cfg["line"]
        display_name = cfg.get("name", key_id)

        try:
            if chip_name not in self._chips:
                self._chips[chip_name] = gpiod.Chip(chip_name)

            chip = self._chips[chip_name]
            line = chip.get_line(line_num)
            line.request(
                consumer=f"clawbox-key-{key_id}",
                type=gpiod.LINE_REQ_DIR_IN,
                flags=gpiod.LINE_REQ_FLAG_BIAS_PULL_UP,  # 内部上拉，按下=0
            )

            self._keys[key_id] = {
                "chip": chip,
                "line": line,
                "available": True,
                "name": display_name,
                "last_state": 1,          # 上次读取值 (1=未按下)
                "last_change": 0.0,       # 上次状态变化时间
                "pressed": False,         # 当前是否处于按下状态
                "press_start": 0.0,       # 按下开始时间
                "long_fired": False,      # 长按事件是否已触发
            }
            logger.info(f"按键 [{display_name}] 初始化成功: {chip_name}:line{line_num}")

        except Exception as e:
            self._keys[key_id] = {
                "available": False,
                "reason": str(e),
                "name": display_name,
            }
            logger.warning(f"按键 [{display_name}] 初始化失败 ({chip_name}:line{line_num}): {e}")

    # ---- 公开 API ----

    def poll(self) -> None:
        """扫描所有按键状态（主循环每次迭代调用）"""
        now = time.monotonic()

        for key_id, info in self._keys.items():
            if not info.get("available"):
                continue

            try:
                current = info["line"].get_value()
            except (OSError, ValueError) as e:
                logger.error(f"读取按键 [{key_id}] 失败: {e}")
                info["available"] = False
                continue

            last = info["last_state"]

            # 状态未变化
            if current == last:
                # 检查长按
                if (info["pressed"] and not info["long_fired"]
                        and (now - info["press_start"]) >= self._long_press_s):
                    info["long_fired"] = True
                    logger.info(f"按键 [{info['name']}] 长按触发")
                    self._callback(key_id, "long")
                continue

            # 去抖检查
            if (now - info["last_change"]) < self._debounce_s:
                continue

            info["last_state"] = current
            info["last_change"] = now

            if current == 0:  # 按下 (低电平)
                info["pressed"] = True
                info["press_start"] = now
                info["long_fired"] = False
                logger.debug(f"按键 [{info['name']}] 按下")
                # 不在按下时立即触发回调，等松手后再判断短按/长按

            else:  # 释放 (高电平)
                was_pressed = info["pressed"]
                info["pressed"] = False
                logger.debug(f"按键 [{info['name']}] 释放")
                if was_pressed and not info["long_fired"]:
                    # 短按：松手时触发
                    logger.info(f"按键 [{info['name']}] 短按触发")
                    self._callback(key_id, "press")
                info["long_fired"] = False

    def is_available(self, key_id: str) -> bool:
        """检查某个按键是否可用"""
        info = self._keys.get(key_id)
        return bool(info and info.get("available"))

    def is_pressed(self, key_id: str) -> bool:
        """查询某个按键当前是否被按住（用于组合键检测）"""
        info = self._keys.get(key_id)
        if not info or not info.get("available"):
            return False
        return info.get("pressed", False)

    def any_available(self) -> bool:
        """是否至少有一个按键可用"""
        return any(v.get("available") for v in self._keys.values())

    def cleanup(self) -> None:
        """释放所有 GPIO 资源"""
        for info in self._keys.values():
            if info.get("available"):
                try:
                    info["line"].release()
                except OSError:
                    pass

        for chip in self._chips.values():
            try:
                chip.close()
            except OSError:
                pass

        self._keys.clear()
        self._chips.clear()
        logger.info("按键监听器已清理")
