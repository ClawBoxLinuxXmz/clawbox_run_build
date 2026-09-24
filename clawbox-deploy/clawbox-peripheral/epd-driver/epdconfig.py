r"""
epdconfig.py —— 核桃派 GPIO + SPI 适配层
============================================
为微雪墨水屏驱动提供底层 GPIO/SPI 接口。

适配平台: 核桃派2B (Allwinner T527) / 1B (T113)
GPIO:     gpiod (libgpiod)
SPI:      spidev (python3-spidev)

使用前请先确认 GPIO line 编号（不同板子可能不同）:
  gpio readall          # 查看40Pin映射
  gpioinfo | grep -B1 "line.*\(45\|263\|265\)"  # 确认 line 归属

引脚映射 (核桃派2B):
  物理11脚 PB13  → gpiochip1 line 45  (RST)
  物理22脚 PI7   → gpiochip1 line 263 (DC)
  物理18脚 PI9   → gpiochip1 line 265 (BUSY)
  SPI1.0: 物理19(MOSI) 23(SCLK) 24(CS0)
"""

import time
import spidev
import gpiod


class EpdConfig:
    """GPIO + SPI 适配层（实例持有句柄，无模块级可变全局）。

    为什么用类而不是模块级函数+全局: 旧版把 _chip/_rst/_dc/_busy/SPI 放在
    模块级, 多实例/重复 init 时句柄状态隐式共享, 难以测试与复用。
    现在每个 EPD 实例持有一个 EpdConfig, 句柄生命周期跟随实例。
    """

    # 兼容微雪驱动命名 (CS 固定 -1: 由 SPI 总线自动片选)
    CS_PIN = -1

    def __init__(
        self,
        rst_line: int = 45,
        dc_line: int = 263,
        busy_line: int = 265,
        gpio_chip: str = "gpiochip1",
    ) -> None:
        self.rst_line = rst_line
        self.dc_line = dc_line
        self.busy_line = busy_line
        self.gpio_chip = gpio_chip
        # 兼容微雪驱动命名 (驱动层按 RST_PIN/DC_PIN/BUSY_PIN 引用)
        self.RST_PIN = rst_line
        self.DC_PIN = dc_line
        self.BUSY_PIN = busy_line
        self._chip = None
        self._rst = None
        self._dc = None
        self._busy = None
        self._spi = None
        self._ok = False

    def digital_write(self, pin, value):
        if pin == self.RST_PIN and self._rst:
            self._rst.set_value(value)
        elif pin == self.DC_PIN and self._dc:
            self._dc.set_value(value)

    def digital_read(self, pin):
        if pin == self.BUSY_PIN and self._busy:
            return self._busy.get_value()
        return 0

    @staticmethod
    def delay_ms(ms):
        time.sleep(ms / 1000.0)

    def spi_writebyte(self, data):
        self._spi.writebytes(data)

    def spi_writebyte2(self, data):
        """大数据块分片发送（微雪驱动内部调用）"""
        for i in range(0, len(data), 4096):
            self._spi.writebytes(data[i:i + 4096])

    def module_init(self):
        """初始化 GPIO + SPI（支持重复调用不报错）"""
        if self._ok:
            return 0

        self._chip = gpiod.Chip(self.gpio_chip)

        self._rst = self._chip.get_line(self.rst_line)
        self._rst.request(consumer="epd", type=gpiod.LINE_REQ_DIR_OUT)

        self._dc = self._chip.get_line(self.dc_line)
        self._dc.request(consumer="epd", type=gpiod.LINE_REQ_DIR_OUT)

        self._busy = self._chip.get_line(self.busy_line)
        self._busy.request(consumer="epd", type=gpiod.LINE_REQ_DIR_IN)

        self._spi = spidev.SpiDev(1, 0)
        self._spi.max_speed_hz = 2000000
        self._spi.mode = 0b00

        self._ok = True
        return 0

    def module_exit(self):
        """释放 GPIO + 关闭 SPI"""
        if self._spi:
            self._spi.close()
            self._spi = None
        if self._rst:
            self._rst.set_value(0)
            self._rst.release()
            self._rst = None
        if self._dc:
            self._dc.set_value(0)
            self._dc.release()
            self._dc = None
        if self._busy:
            self._busy.release()
            self._busy = None
        if self._chip:
            self._chip.close()
            self._chip = None
        self._ok = False