"""
onboard_button.py —— 核桃派2B 板载按键监听器
=============================================
板载无标注按键 = PB7 (PIO 基址 0x2000000, PB 组 DATA 偏移 0x40, bit7), 低电平有效。

背景 (2026-08-06 实测):
  内核 gpio-keys-polled 驱动(user-keys)已占用该 GPIO, 但 linux,code=0 导致
  它不发出任何输入事件(按键实际是"死"的); 且解绑该驱动会让系统卡死。
  因此这里直接 mmap /dev/mem 读 PIO 数据寄存器来检测按键, 不碰内核驱动。

回调签名: callback(key_id, event)
    key_id: "board"
    event:  "press" - 短按(松手时触发)
            "long"  - 长按(按住超过阈值)
"""

import logging
import mmap
import os
import struct
import time

logger = logging.getLogger("clawbox.obtn")

# PIO 控制器寄存器区 (见 /proc/iomem: 2000000.pinctrl pio, 0x02000000-0x020007ff)
PIO_BASE = 0x2000000
PIO_SIZE = 0x800
# PB 组 DATA 寄存器偏移: 实测按键翻转 bit7 (0x1C0 ↔ 0x140)
PB_DATA_OFFSET = 0x40
PB7_MASK = 1 << 7


class OnboardButton:
    """板载按键监听器 (直接读 PIO 寄存器, 去抖 + 长按检测)"""

    def __init__(self,
                 callback,
                 debounce_ms: int = 60,
                 long_press_ms: int = 3000):
        self._callback = callback
        self._debounce_s = debounce_ms / 1000.0
        self._long_press_s = long_press_ms / 1000.0

        self._mem = None
        self._available = False

        # 状态机 (与 key_listener.py 约定一致: 0=按下, 1=未按下)
        self._last_state = 1          # 上次读取值 (1=未按下)
        self._last_change = 0.0       # 上次状态变化时间
        self._pressed = False         # 当前是否处于按下状态
        self._press_start = 0.0       # 按下开始时间
        self._long_fired = False      # 长按事件是否已触发

        self._init_mem()

    def _init_mem(self) -> None:
        try:
            fd = os.open("/dev/mem", os.O_RDONLY | os.O_SYNC)
            self._mem = mmap.mmap(
                fd, PIO_SIZE, mmap.MAP_SHARED, mmap.PROT_READ, offset=PIO_BASE,
            )
            os.close(fd)
            self._available = True
            logger.info("板载按键初始化成功 (PIO+0x40 bit7)")
        except (OSError, ValueError) as e:
            self._available = False
            logger.warning(f"板载按键初始化失败: {e}")

    def _read_value(self) -> int:
        """读取按键电平: 0=按下(低), 1=未按下(高)
        实测 (2026-08-06): 未按 bit7=1(0x1C0), 按下 bit7=0(0x140)"""
        word = struct.unpack_from("<I", self._mem, PB_DATA_OFFSET)[0]
        return 1 if (word & PB7_MASK) else 0

    def poll(self) -> None:
        """扫描板载按键状态 (主循环每次迭代调用)"""
        if not self._available:
            return
        now = time.monotonic()

        try:
            current = self._read_value()
        except (OSError, ValueError) as e:
            logger.error(f"读取板载按键失败: {e}")
            self._available = False
            return

        last = self._last_state

        # 状态未变化
        if current == last:
            # 检查长按
            if (self._pressed and not self._long_fired
                    and (now - self._press_start) >= self._long_press_s):
                self._long_fired = True
                logger.info("板载按键长按触发")
                self._callback("board", "long")
            return

        # 去抖检查
        if (now - self._last_change) < self._debounce_s:
            return

        self._last_state = current
        self._last_change = now

        if current == 0:  # 按下 (低电平)
            self._pressed = True
            self._press_start = now
            self._long_fired = False
        else:             # 释放 (高电平)
            was_pressed = self._pressed
            self._pressed = False
            if was_pressed and not self._long_fired:
                # 短按: 松手时触发
                logger.info("板载按键短按触发")
                self._callback("board", "press")
            self._long_fired = False

    def is_available(self) -> bool:
        return self._available

    def cleanup(self) -> None:
        if self._mem:
            try:
                self._mem.close()
            except OSError:
                pass
            self._mem = None
        self._available = False
        logger.info("板载按键监听器已清理")
