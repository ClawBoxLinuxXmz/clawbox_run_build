# *****************************************************************************
# * | File        :       epd1in54_152.py
# * | Author      :   ClawBox
# * | Function    :   1.54" 152x152 e-Paper driver (SSD1680)
# * | Info        :
# *----------------
# * | This version:   1.1
# * | Date        :   2026-08-10
# * | Info        :   B&W driver; 全刷 ~2s + 局刷 ~0.5s (SSD1680 partial, 官方 0x22=0xDC)。
# * |                 局刷需 init_partial+prepare_partial 打底，每 N 次局刷全刷一次清残影。
# * |                 GPIO/SPI via epdconfig.py.
# -----------------------------------------------------------------------------

import logging
from typing import Optional

from epdconfig import EpdConfig

EPD_WIDTH = 152
EPD_HEIGHT = 152
_BUF_BYTES = int(EPD_WIDTH / 8) * EPD_HEIGHT  # 2888

logger = logging.getLogger(__name__)


class EPD:
    def __init__(self, cfg: Optional[EpdConfig] = None):
        # 每个 EPD 实例持有一个 EpdConfig, 句柄生命周期跟随实例 (无模块级全局)
        self._cfg = cfg or EpdConfig()
        self.reset_pin = self._cfg.RST_PIN
        self.dc_pin = self._cfg.DC_PIN
        self.busy_pin = self._cfg.BUSY_PIN
        self.cs_pin = self._cfg.CS_PIN
        self.width = EPD_WIDTH
        self.height = EPD_HEIGHT

    # ── SPI helpers ──

    def _hw_reset(self):
        self._cfg.digital_write(self.reset_pin, 1)
        self._cfg.delay_ms(100)
        self._cfg.digital_write(self.reset_pin, 0)
        self._cfg.delay_ms(10)
        self._cfg.digital_write(self.reset_pin, 1)
        self._cfg.delay_ms(10)

    def send_command(self, command):
        self._cfg.digital_write(self.dc_pin, 0)
        self._cfg.digital_write(self.cs_pin, 0)
        self._cfg.spi_writebyte([command])
        self._cfg.digital_write(self.cs_pin, 1)

    def send_data(self, data):
        self._cfg.digital_write(self.dc_pin, 1)
        self._cfg.digital_write(self.cs_pin, 0)
        self._cfg.spi_writebyte([data])
        self._cfg.digital_write(self.cs_pin, 1)

    def send_data2(self, data):
        self._cfg.digital_write(self.dc_pin, 1)
        self._cfg.digital_write(self.cs_pin, 0)
        self._cfg.spi_writebyte2(data)
        self._cfg.digital_write(self.cs_pin, 1)

    def ReadBusy(self, timeout_ms=5000):
        """Wait while BUSY=1 (active HIGH). Return True if BUSY was observed."""
        waited_ms = 0
        saw_busy = False
        while self._cfg.digital_read(self.busy_pin) == 1:
            saw_busy = True
            self._cfg.delay_ms(20)
            waited_ms += 20
            if waited_ms >= timeout_ms:
                logger.warning("BUSY等待超时，继续执行")
                return saw_busy
        return saw_busy

    # ── Init ──

    def init(self):
        if self._cfg.module_init() != 0:
            return -1
        self._hw_reset()
        self.ReadBusy()
        self.send_command(0x12)
        self.ReadBusy()
        return 0

    # ── Frame buffer ──

    def getbuffer(self, image):
        """Convert 1-bit PIL Image (152x152) to frame buffer (2888 bytes).
        0x00 = black, 0xFF = white. Horizontal mirror flip applied."""
        buf = bytearray([0xFF]) * _BUF_BYTES
        img = image.convert('1')
        imwidth, imheight = img.size
        pixels = img.load()

        if imwidth == self.width and imheight == self.height:
            for y in range(imheight):
                for x in range(imwidth):
                    if pixels[x, y] == 0:
                        mx = self.width - 1 - x
                        byte_idx = (mx + y * self.width) // 8
                        bit_idx = 7 - (mx % 8)
                        buf[byte_idx] &= ~(1 << bit_idx)
        elif imwidth == self.height and imheight == self.width:
            for y in range(imheight):
                for x in range(imwidth):
                    if pixels[x, y] == 0:
                        nx, ny = y, self.height - x - 1
                        mx = self.width - 1 - nx
                        byte_idx = (mx + ny * self.width) // 8
                        bit_idx = 7 - (mx % 8)
                        buf[byte_idx] &= ~(1 << bit_idx)
        return bytes(buf)

    # ── Display ──

    def display(self, image):
        """Write frame buffer to 0x24 (B&W RAM). No refresh trigger."""
        if image is None:
            return
        self.send_command(0x24)
        self.send_data2(image)

    def update(self):
        """Full refresh: 0x22=0xF4 then 0x20, BUSY wait (~2s for B&W).
        必须显式写 0x22=0xF4：否则会沿用上次的 0x22 值（如局刷 0xDC）导致实际执行成局刷。"""
        self.send_command(0x22)
        self.send_data(0xF4)
        self.send_command(0x20)
        if not self.ReadBusy(timeout_ms=5000):
            logger.debug("BUSY未进入忙状态，使用固定延时兜底")
            self._cfg.delay_ms(2200)

    # ── Partial refresh (fast, may leave ghosting) ──

    def display_partial(self, image):
        """写帧 buffer 供局刷（0x24）。

        2026-08-11 重构: 微雪 C 驱动沿用的旧大写 display_Partial 已并入本方法,
        全仓调用点统一小写 display_partial。
        """
        if image is None:
            return
        self.send_command(0x24)
        self.send_data2(image)

    def update_partial(self):
        """Partial refresh activation (~0.5s). 官方局刷控制字 0x22=0xDC
        （原 0xFF 不在官方定义的组合内，是 7.30 实测局刷残影的根因之一）。
        局刷会残留残影，上层须每 N 次局刷后全刷一次清除。"""
        self.send_command(0x22)
        self.send_data(0xDC)
        self.send_command(0x20)
        if not self.ReadBusy(timeout_ms=2500):
            logger.debug("BUSY未进入忙状态，使用局刷固定延时兜底")
            self._cfg.delay_ms(800)

    def init_partial(self):
        """加载局刷波形（对应官方例程 FastMode1Init）。局刷前必须先执行。
        官方序列：SWRESET + 温度传感器(0x18=0x80) + 加载OTP波形(0x22=0xB1)
        + 温度波形参数(0x1A) + 0x22=0x91；缺它会用错波形 → 对比度差/残影。"""
        if self._cfg.module_init() != 0:
            return -1
        self._hw_reset()
        self.ReadBusy()
        self.send_command(0x12)      # SWRESET
        self.ReadBusy()
        self.send_command(0x18)      # 温度传感器控制
        self.send_data(0x80)         # 使用内部温度传感器
        self.send_command(0x22)
        self.send_data(0xB1)         # 加载 OTP 局刷波形 LUT
        self.send_command(0x20)
        self.ReadBusy()
        self.send_command(0x1A)      # 温度相关波形参数
        self.send_data(0x64)
        self.send_data(0x00)
        self.send_command(0x22)
        self.send_data(0x91)
        self.send_command(0x20)
        self.ReadBusy()
        return 0

    def prepare_partial(self):
        """局刷打底（对应官方 Display_Clear + FastUpdate + Clear_R26H）：
        清屏为白 + 写 0x26 备份 buffer 全白。SSD1680 局刷以 0x26 为参考帧，
        不打底则无参考 → 残影/花屏。"""
        self.send_command(0x3C)
        self.send_data(0x05)         # 边框波形
        self.send_command(0x24)
        self.send_data2(bytes([0xFF]) * _BUF_BYTES)   # RAM B&W 全白
        self.ReadBusy()
        self.send_command(0x26)
        self.send_data2(bytes([0x00]) * _BUF_BYTES)   # RAM 备份 全黑
        self.send_command(0x22)
        self.send_data(0xC7)         # 快刷显示空白（官方 FastUpdate）
        self.send_command(0x20)
        self.ReadBusy()
        self.send_command(0x26)
        self.send_data2(bytes([0xFF]) * _BUF_BYTES)   # 备份 buffer 置白（Clear_R26H）

    def write_backup(self, image):
        """写 0x26 备份 buffer 为指定帧。全刷后调用使 R26 与屏幕显示同步，
        后续局刷只驱动差异像素，避免整屏重驱动与残影累积。"""
        self.send_command(0x26)
        self.send_data2(image)

    # ── Clear ──

    def Clear(self):
        white = bytes([0xFF]) * _BUF_BYTES
        self.send_command(0x24)
        self.send_data2(white)
        self.ReadBusy()

    # ── Sleep ──

    def sleep(self):
        self.send_command(0x10)
        self.send_data(0x01)
        self._cfg.delay_ms(200)
        self._cfg.module_exit()
