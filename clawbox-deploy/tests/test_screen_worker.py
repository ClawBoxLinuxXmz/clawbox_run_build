"""screen_worker.py —— 屏幕生产者-消费者线程单测。

用 FakeScreen 打桩 SPI 传输, 验证版本号机制与失败重初始化。
"""

import threading
import time

import screen_worker
from screen_worker import ScreenWorker


class FakeScreen:
    def __init__(self, fail=False):
        self.shown = []
        self.available = True
        self.fail = fail
        self.cleanup_called = False

    def show_page(self, page, image):
        if self.fail:
            raise RuntimeError("spi fail")
        self.shown.append((page, image))

    def cleanup(self):
        self.cleanup_called = True


def _wait_until(cond, timeout=5.0, interval=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(interval)
    return False


def test_request_and_display():
    screen = FakeScreen()
    worker = ScreenWorker(screen=screen)
    worker.start()
    try:
        worker.request(1, "img1")
        assert _wait_until(lambda: bool(screen.shown))
        assert screen.shown == [(1, "img1")]
    finally:
        worker.stop()


def test_request_keeps_latest():
    screen = FakeScreen()
    worker = ScreenWorker(screen=screen)
    worker.start()
    try:
        worker.request(1, "img1")
        worker.request(2, "img2")
        assert _wait_until(lambda: screen.shown and screen.shown[-1][1] == "img2")
        # 最终显示最新帧 (可能先显示 img1 再 img2, 也可能直接 img2)
        assert screen.shown[-1] == (2, "img2")
    finally:
        worker.stop()


def test_reinit_after_consecutive_failures(monkeypatch):
    """连续失败达到阈值 → 尝试重新初始化; 构造失败 → 丢弃当前帧不再死循环。"""
    screen = FakeScreen(fail=True)
    worker = ScreenWorker(screen=screen)

    def _boom(*a, **k):
        raise RuntimeError("no driver on PC")

    monkeypatch.setattr(screen_worker, "ScreenRenderer", _boom)
    worker.start()
    try:
        worker.request(1, "img1")
        # 等待失败计数触发重初始化并丢弃帧
        assert _wait_until(lambda: worker._done_version == 1, timeout=10.0)
        assert screen.cleanup_called
        assert worker._fail_count == 0
    finally:
        worker.stop()


def test_start_is_idempotent():
    screen = FakeScreen()
    worker = ScreenWorker(screen=screen)
    worker.start()
    worker.start()   # 不应创建第二个线程
    assert worker._thread is not None
    assert worker._thread.is_alive()
    assert worker.stop()
    assert not worker._thread.is_alive()


def test_stop_reports_timeout_until_inflight_spi_finishes():
    """join 超时不能假装线程已停；调用方据此避免并发清理 SPI。"""
    entered = threading.Event()
    release = threading.Event()

    class BlockingScreen(FakeScreen):
        def show_page(self, page, image):
            entered.set()
            release.wait(timeout=5.0)
            super().show_page(page, image)

    worker = ScreenWorker(screen=BlockingScreen())
    worker.start()
    worker.request(1, "img")
    assert entered.wait(timeout=2.0)

    assert worker.stop(timeout=0.01) is False
    assert worker._thread is not None and worker._thread.is_alive()

    release.set()
    assert worker.stop(timeout=2.0) is True
    assert not worker._thread.is_alive()
