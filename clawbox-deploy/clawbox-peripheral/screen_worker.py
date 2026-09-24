"""
ClawBox 外设守护进程 —— 屏幕刷新工作线程
==========================================
主线程生成图像 (PIL/字体/QR), 后台线程只做 SPI 传输, 彻底避免跨线程状态混乱。

- 版本号机制: 主线程每生成一张图 version+1, 工作线程只显示最新版本
- 连续 SPI 失败自动重新初始化屏幕
- 线程级兜底: 未知异常不杀线程, 记录后继续 (2026-08-11)
"""

import logging
import os
import threading
import time
from typing import Any, Optional

from screen_renderer import ScreenRenderer

logger = logging.getLogger("clawbox.screen")

_SPI_LOCK_PATH = "/run/clawbox-spi.lock"
try:
    import fcntl  # Linux only; Windows PC 侧无此模块
    _HAS_FCNTL = True
except ImportError:
    fcntl = None  # type: ignore
    _HAS_FCNTL = False

_SCREEN_MAX_FAILS = 5   # 连续 SPI 失败超过此数尝试重新初始化屏幕


class ScreenWorker:
    """生产者-消费者屏幕线程。

    request() 由主线程调用 (只入队+版本号+1);
    后台线程消费队列并执行 SPI 传输, 失败自动重初始化。
    """

    def __init__(self, screen: Optional[ScreenRenderer] = None) -> None:
        self._screen = screen
        self._lock = threading.Lock()
        self._pending_image: Optional[Any] = None   # PIL Image, 主线程生成
        self._pending_page: int = 0                 # 对应的页面编号
        self._image_version = 0                     # 主线程每生成一张 +1
        self._done_version = 0                      # 工作线程已显示的版本号
        self._fail_count = 0                        # 连续 SPI 失败计数
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._spi_lock_fd: Optional[int] = None

    @property
    def screen(self) -> Optional[ScreenRenderer]:
        """当前屏幕渲染器 (SPI 连续失败后可能被重新初始化替换)。"""
        return self._screen

    def _try_spi_lock(self) -> None:
        """保持 SPI 独占，仅做可观测告警，不阻塞。锁随进程退出自动释放，无残留。"""
        if not _HAS_FCNTL or self._spi_lock_fd is not None:
            return
        try:
            os.makedirs(os.path.dirname(_SPI_LOCK_PATH), exist_ok=True)
            self._spi_lock_fd = os.open(_SPI_LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o644)  # noqa: SIM115
            try:
                fcntl.flock(self._spi_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                try:
                    os.ftruncate(self._spi_lock_fd, 0)
                    os.write(self._spi_lock_fd, f"{os.getpid()}\n".encode())
                except OSError:
                    pass
            except OSError as e:
                if getattr(e, "errno", None) == 11:  # EAGAIN
                    try:
                        holder = os.read(self._spi_lock_fd, 64).decode().strip()
                    except OSError:
                        holder = "unknown"
                    logger.warning(f"SPI 独占检测到占用 (holder pid={holder or 'unknown'})，保持独占但不阻塞")
                try:
                    os.close(self._spi_lock_fd)
                except OSError:
                    pass
                self._spi_lock_fd = None
        except OSError:
            self._spi_lock_fd = None

    def _release_spi_lock(self) -> None:
        """仅在线程停止后释放，避免另一个进程趁当前线程仍在刷屏时进入。"""
        if self._spi_lock_fd is None:
            return
        try:
            fcntl.flock(self._spi_lock_fd, fcntl.LOCK_UN)
        except OSError:
            logger.debug("释放 SPI 独占锁失败", exc_info=True)
        try:
            os.close(self._spi_lock_fd)
        except OSError:
            logger.debug("关闭 SPI 独占锁文件失败", exc_info=True)
        self._spi_lock_fd = None

    def start(self) -> None:
        """启动后台线程 (幂等: 已在运行则忽略)。"""
        if self._thread and self._thread.is_alive():
            return
        self._try_spi_lock()
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="screen-worker")
        self._thread.start()

    def stop(self, timeout: float = 0.5) -> bool:
        """请求后台线程退出，并返回它是否已完全停止。

        墨水屏刷新可能正在 BUSY 等待，join 超时并不代表线程已经退出。调用方
        只有在本方法返回 True 后，才可以从其他线程直接清屏、休眠或释放 SPI。
        """
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=timeout)
        stopped = self._thread is None or not self._thread.is_alive()
        if stopped:
            self._release_spi_lock()
        return stopped

    def request(self, page: int, image: Any) -> int:
        """主线程调用: 提交一张待显示图像, 返回新版本号。"""
        with self._lock:
            self._pending_image = image
            self._pending_page = page
            self._image_version += 1
            new_ver = self._image_version
        logger.info(f"页面{page} 图像已生成 (ver={new_ver})，等待SPI传输")
        return new_ver

    # ---- 后台线程 ----

    def _run(self) -> None:
        """后台线程: 只负责把图像推送到 SPI, 不触碰任何其他状态。"""
        while self._running:
            try:
                with self._lock:
                    img = self._pending_image
                    page = self._pending_page
                    ver = self._image_version
                if img is not None and ver != self._done_version:
                    try:
                        if self._screen is None:
                            raise RuntimeError("屏幕对象未初始化")
                        self._screen.show_page(page, img)
                        self._done_version = ver
                        self._fail_count = 0
                        logger.info(f"屏幕刷新完成 page={page} ver={ver}")
                    except Exception as e:
                        self._fail_count += 1
                        logger.error(f"屏幕SPI传输异常 (#{self._fail_count}): {e}")
                        if self._fail_count >= _SCREEN_MAX_FAILS:
                            self._reinit_screen(ver)
                        time.sleep(0.2)
                else:
                    time.sleep(0.08)
            except Exception as e:
                # 线程级兜底: 未知异常不杀线程, 记录后继续 (2026-08-11)
                logger.exception(f"屏幕工作线程异常: {e}")
                time.sleep(0.5)

    def _reinit_screen(self, ver: int) -> None:
        """连续失败后尝试重新初始化屏幕; 仍不可用时丢弃当前帧避免死循环。"""
        logger.warning(
            f"屏幕连续失败 {_SCREEN_MAX_FAILS} 次，尝试重新初始化..."
        )
        try:
            if self._screen:
                self._screen.cleanup()
        except Exception:
            pass
        recovered = False
        try:
            self._screen = ScreenRenderer()
            if self._screen.available:
                recovered = True
                logger.info("屏幕重新初始化成功")
            else:
                logger.warning("屏幕重新初始化后仍不可用")
        except Exception as re_:
            logger.error(f"屏幕重新初始化失败: {re_}")
        self._fail_count = 0
        if not recovered:
            # 屏幕不可用时丢弃当前帧，避免后台线程持续刷同一张图。
            self._done_version = ver
