"""
屏幕渲染器 (B&W) —— 152x152 纯黑白墨水屏
==========================================
单通道渲染，全刷 ~2s。
"""

import logging
import os
import sys
import time

# 局刷节奏配置（取自守护进程 config.py 配置中心；独立运行/单测时默认值兜底）
try:
    from config import PARTIAL_IDLE_TIMEOUT, PARTIAL_REFRESH_EVERY
except ImportError:
    PARTIAL_REFRESH_EVERY = 9
    PARTIAL_IDLE_TIMEOUT = 60.0

logger = logging.getLogger("clawbox.screen")

HAS_EPD = False

try:
    _epd_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "epd-driver")
    if os.path.isdir(_epd_dir) and _epd_dir not in sys.path:
        sys.path.insert(0, _epd_dir)

    import epd1in54_152
    from epdconfig import EpdConfig
    HAS_EPD = True
    logger.info("B&W 墨水屏驱动加载成功 (SSD1680 152x152)")
except ImportError as e:
    logger.warning(f"B&W 驱动加载失败: {e}")


class ScreenRenderer:
    """1.54\" 152x152 B&W 墨水屏渲染器"""

    def __init__(self):
        self._epd = None
        self._available = False
        self._partial_inited = False   # 局刷模式是否已打底（R26 备份已同步）
        self._partial_count = 0        # 连续局刷次数
        self._last_refresh = 0.0       # 上次刷新时间戳（空闲超时用）

        if not HAS_EPD:
            logger.warning("墨水屏不可用")
            return

        try:
            self._epd = epd1in54_152.EPD(EpdConfig())
            self._available = True
            logger.info("EPD 实例创建成功")
        except Exception as e:
            logger.warning(f"墨水屏初始化失败: {e}")

    @property
    def available(self) -> bool:
        return self._available

    def show_boot(self):
        from screen_pages import render_boot_screen
        self._display(render_boot_screen())

    def show_page(self, _page_num, bw_image):
        """显示页面图像 (单通道 B&W, 纯黑白屏无 red 通道)。"""
        if not self._available:
            raise RuntimeError("墨水屏不可用")
        self._display(bw_image)

    def show_image(self, image):
        if not self._available:
            raise RuntimeError("墨水屏不可用")
        self._display(image)

    def clear(self):
        if not self._available or not self._epd:
            return
        try:
            self._epd.init()
            self._epd.Clear()
            self._epd.update()
            self._partial_inited = False
            self._partial_count = 0
        except Exception as e:
            logger.warning(f"清屏失败: {e}")

    def sleep(self):
        if not self._available or not self._epd:
            return
        try:
            self._epd.sleep()
        except Exception as e:
            logger.warning(f"休眠失败: {e}")

    def cleanup(self):
        self.clear()
        self._available = False
        self._epd = None

    def _display(self, image):
        """局刷节奏显示：首次打底后局刷，每 PARTIAL_REFRESH_EVERY 次局刷全刷 1 次清残影。
        局刷模式不 sleep（保持驱动清醒），空闲超时后自动休眠省电（下次自动重新打底）。"""
        if not self._available or not self._epd:
            return
        now = time.monotonic()
        try:
            # 空闲超时：休眠并重置局刷状态，下次刷新重新打底
            if self._partial_inited and (now - self._last_refresh) > PARTIAL_IDLE_TIMEOUT:
                self._epd.sleep()
                self._partial_inited = False
                self._partial_count = 0

            if not self._partial_inited:
                # 首次/超时后：加载局刷波形 + 打底（白屏 + R26 备份），随后局刷显示当前帧
                self._epd.init_partial()
                self._epd.prepare_partial()
                self._partial_inited = True
                self._partial_count = 0

            self._partial_count += 1
            buf = self._epd.getbuffer(image)
            if self._partial_count > PARTIAL_REFRESH_EVERY:
                # 每 N 次局刷后：干净全刷清残影 + R26 同步当前帧（后续局刷只刷差异像素）
                self._epd.init()
                self._epd.display(buf)
                self._epd.update()
                self._epd.write_backup(buf)
                self._partial_count = 0
            else:
                self._epd.display_partial(buf)
                self._epd.update_partial()
            self._last_refresh = now
        except Exception as e:
            logger.warning(f"刷新失败: {e}")
            self._partial_inited = False   # 出错回退到下次全刷打底，避免残影累积
            raise
