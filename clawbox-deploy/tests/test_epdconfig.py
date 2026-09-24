"""epdconfig.py —— GPIO/SPI 适配层单测。

PC 无 spidev/gpiod, 用 fake 模块打桩后 import, 验证 EpdConfig 生命周期
与引脚读写逻辑 (不触碰真实硬件)。每个测试后清理 sys.modules, 避免
fake 模块污染其他测试 (screen_renderer 的驱动加载 try/except 依赖
"PC 无 spidev → HAS_EPD=False" 的原始状态)。
"""

import os
import sys
import types
import importlib

import pytest

# epd-driver 不在 conftest 的 sys.path 里, 这里补上
_EPD_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "clawbox-peripheral", "epd-driver",
)
if _EPD_DIR not in sys.path:
    sys.path.insert(0, _EPD_DIR)


class FakeLine:
    def __init__(self, name):
        self.name = name
        self.value = 0
        self.req_type = None
        self.released = False

    def request(self, consumer=None, type=None):
        self.req_type = type

    def set_value(self, v):
        self.value = v

    def get_value(self):
        return self.value

    def release(self):
        self.released = True


class FakeChip:
    def __init__(self, name):
        self.name = name
        self.lines = {}
        self.closed = False

    def get_line(self, n):
        if n not in self.lines:
            self.lines[n] = FakeLine(f"{self.name}:{n}")
        return self.lines[n]

    def close(self):
        self.closed = True


class FakeSpiDev:
    def __init__(self, bus, dev):
        self.bus = bus
        self.dev = dev
        self.max_speed_hz = 0
        self.mode = None
        self.written = []
        self.closed = False

    def writebytes(self, data):
        self.written.append(bytes(data))

    def close(self):
        self.closed = True


@pytest.fixture(autouse=True)
def _cleanup_epd_modules():
    """每个测试后清理 fake 与 epdconfig, 不污染其他测试的驱动加载状态。"""
    yield
    for name in ("epdconfig", "epd1in54_152", "gpiod", "spidev"):
        sys.modules.pop(name, None)


def _install_fakes():
    fake_gpiod = types.ModuleType("gpiod")
    fake_gpiod.Chip = FakeChip
    fake_gpiod.LINE_REQ_DIR_OUT = "out"
    fake_gpiod.LINE_REQ_DIR_IN = "in"
    fake_spidev = types.ModuleType("spidev")
    fake_spidev.SpiDev = FakeSpiDev
    sys.modules["gpiod"] = fake_gpiod
    sys.modules["spidev"] = fake_spidev


def _load_epdconfig():
    if "epdconfig" in sys.modules:
        del sys.modules["epdconfig"]
    return importlib.import_module("epdconfig")


def test_default_pins_compat_naming():
    _install_fakes()
    epdconfig = _load_epdconfig()
    cfg = epdconfig.EpdConfig()
    assert cfg.RST_PIN == 45
    assert cfg.DC_PIN == 263
    assert cfg.BUSY_PIN == 265
    assert cfg.CS_PIN == -1


def test_custom_pins():
    _install_fakes()
    epdconfig = _load_epdconfig()
    cfg = epdconfig.EpdConfig(rst_line=1, dc_line=2, busy_line=3, gpio_chip="gpiochip0")
    assert (cfg.RST_PIN, cfg.DC_PIN, cfg.BUSY_PIN) == (1, 2, 3)
    assert cfg.gpio_chip == "gpiochip0"


def test_module_init_requests_lines_and_spi():
    _install_fakes()
    epdconfig = _load_epdconfig()
    cfg = epdconfig.EpdConfig()
    assert cfg.module_init() == 0
    chip = cfg._chip
    assert chip.name == "gpiochip1"
    assert chip.lines[45].req_type == "out"
    assert chip.lines[263].req_type == "out"
    assert chip.lines[265].req_type == "in"
    assert cfg._spi.bus == 1 and cfg._spi.dev == 0
    assert cfg._spi.max_speed_hz == 2000000
    assert cfg._spi.mode == 0b00


def test_module_init_idempotent():
    _install_fakes()
    epdconfig = _load_epdconfig()
    cfg = epdconfig.EpdConfig()
    assert cfg.module_init() == 0
    first_chip = cfg._chip
    assert cfg.module_init() == 0
    assert cfg._chip is first_chip  # 重复调用不重建句柄


def test_digital_write_read_routing():
    _install_fakes()
    epdconfig = _load_epdconfig()
    cfg = epdconfig.EpdConfig()
    cfg.module_init()
    cfg.digital_write(cfg.RST_PIN, 1)
    assert cfg._rst.value == 1
    cfg.digital_write(cfg.DC_PIN, 0)
    assert cfg._dc.value == 0
    cfg._busy.value = 1
    assert cfg.digital_read(cfg.BUSY_PIN) == 1
    # 未初始化时读写安全返回, 不抛异常
    cfg2 = epdconfig.EpdConfig()
    assert cfg2.digital_read(cfg2.BUSY_PIN) == 0
    cfg2.digital_write(cfg2.RST_PIN, 1)


def test_spi_writebyte2_chunks():
    _install_fakes()
    epdconfig = _load_epdconfig()
    cfg = epdconfig.EpdConfig()
    cfg.module_init()
    big = bytes(range(256)) * 20  # 5120 字节 > 4096 分片阈值
    cfg.spi_writebyte2(big)
    assert len(cfg._spi.written) == 2
    assert b"".join(cfg._spi.written) == big


def test_module_exit_releases_all():
    _install_fakes()
    epdconfig = _load_epdconfig()
    cfg = epdconfig.EpdConfig()
    cfg.module_init()
    cfg.module_exit()
    assert cfg._spi is None
    assert cfg._rst is None
    assert cfg._dc is None
    assert cfg._busy is None
    assert cfg._chip is None
    assert cfg._ok is False