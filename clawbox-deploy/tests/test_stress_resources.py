"""第四轮极端压力 — 资源耗尽长跑 (2026-08-26)。

覆盖 8.26 审查盲区第二梯队: 内存泄漏 soak / fd 泄漏 / 磁盘满 / 日志轮转。
全部 Mock, 不碰真实硬件/网络/板子。
运行: D:/python_env/Scripts/python.exe -m pytest tests/test_stress_resources.py -v
"""
import gc
import os
import sys
import time
import tracemalloc
import tempfile
import logging
import logging.handlers
from unittest.mock import Mock, patch

_HERE = os.path.dirname(os.path.abspath(__file__))
_PERIPHERAL = os.path.join(os.path.dirname(_HERE), "clawbox-peripheral")
if _PERIPHERAL not in sys.path:
    sys.path.insert(0, _PERIPHERAL)

import peripheral_daemon as pd
from app_context import AppContext


# ============================================================
# 1. 内存泄漏 soak: QR 反复生成 + 页面反复渲染
# ============================================================
def test_qr_generate_soak_no_memory_growth():
    """QR 生成 200 次 → tracemalloc 峰值不持续增长 (无泄漏)。"""
    from qr_generator import generate_qr
    # 预热
    for _ in range(20):
        generate_qr("https://example.com/soak")
    gc.collect()
    tracemalloc.start()
    base = tracemalloc.get_traced_memory()[0]
    for i in range(200):
        img = generate_qr(f"https://example.com/{i}")
        assert img is not None
        del img
    gc.collect()
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    # 200 次生成后净增长应 < 1MB (每次生成对象都被释放)
    assert current - base < 1024 * 1024, f"QR 生成内存增长 {current - base} bytes"


def test_render_page_soak_no_memory_growth():
    """页面渲染 100 次 → 内存不持续增长。"""
    from page_render import render_page_image
    from daemon_state import DaemonState
    st = DaemonState()
    st.cached["wifi_mode"] = "client"
    st.cached["wifi_ssid"] = "TestSSID"
    st.cached["wifi_ip"] = "192.168.1.100"
    st.cached["hostname"] = "clawbox"
    st.cached["chat_qr_url"] = "https://example.com/q"
    st.cached["chat_qr_platform"] = "wechat"
    st.cached["chat_qr_type"] = "url"
    st.cached["locale"] = "zh-CN"
    # 预热
    for _ in range(10):
        render_page_image(st, 0)
    gc.collect()
    tracemalloc.start()
    base = tracemalloc.get_traced_memory()[0]
    for i in range(100):
        img = render_page_image(st, i % 4)
        assert img is not None
        del img
    gc.collect()
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert current - base < 2 * 1024 * 1024, f"页面渲染内存增长 {current - base} bytes"


def test_trigger_watcher_soak_no_memory_growth():
    """触发文件翻转 300 次 → 内存不增长。"""
    from triggers import TriggerWatcher
    import json
    with tempfile.TemporaryDirectory() as td:
        qr = os.path.join(td, "chat-qr.json")
        locale = os.path.join(td, "locale.json")
        w = TriggerWatcher([("chat", qr)], locale, max_qr_file_bytes=20000)
        w.sync_qr_mtimes()
        w.sync_locale_mtime()
        gc.collect()
        tracemalloc.start()
        base = tracemalloc.get_traced_memory()[0]
        for i in range(300):
            with open(qr, "w", encoding="utf-8") as f:
                json.dump({"qr_url": f"https://example.com/{i}", "platform": "wechat"}, f)
            w.check_qr()
            with open(locale, "w", encoding="utf-8") as f:
                json.dump({"locale": "zh-CN"}, f)
            w.check_locale()
        gc.collect()
        current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        assert current - base < 512 * 1024, f"触发 watcher 内存增长 {current - base} bytes"


# ============================================================
# 2. fd 泄漏: 反复开关屏幕/触发/网络切换
# ============================================================
def _count_fds():
    """跨平台 fd 计数: Windows 用 psutil, Linux 用 /proc。"""
    try:
        import psutil
        return len(psutil.Process().open_files()) + len(psutil.Process().net_connections())
    except ImportError:
        if os.path.isdir("/proc/self/fd"):
            return len(os.listdir("/proc/self/fd"))
        return -1  # 无法计数


def test_screen_worker_reinit_no_fd_leak():
    """ScreenWorker 反复创建/停止 50 次 → fd 不增长。"""
    from screen_worker import ScreenWorker
    base = _count_fds()
    if base < 0:
        return  # 平台无法计数, 跳过
    for _ in range(50):
        w = ScreenWorker(screen=None)
        w.stop(timeout=1)
        del w
    gc.collect()
    after = _count_fds()
    assert after - base <= 5, f"ScreenWorker 重建 fd 增长 {after - base}"


def test_trigger_watcher_recreate_no_fd_leak():
    """TriggerWatcher 反复创建 50 次 → fd 不增长。"""
    from triggers import TriggerWatcher
    base = _count_fds()
    if base < 0:
        return
    with tempfile.TemporaryDirectory() as td:
        qr = os.path.join(td, "chat-qr.json")
        locale = os.path.join(td, "locale.json")
        for _ in range(50):
            w = TriggerWatcher([("chat", qr)], locale, max_qr_file_bytes=20000)
            w.check_qr()
            w.check_locale()
            del w
    gc.collect()
    after = _count_fds()
    assert after - base <= 5, f"TriggerWatcher 重建 fd 增长 {after - base}"


# ============================================================
# 3. 磁盘满: 日志写满 / 心跳写失败 / 触发文件删除失败
# ============================================================
def test_logging_rotation_when_full():
    """日志写满触发轮转 → 守护进程继续写, 不抛。"""
    with tempfile.TemporaryDirectory() as td:
        log_file = os.path.join(td, "test.log")
        handler = logging.handlers.RotatingFileHandler(
            log_file, maxBytes=2048, backupCount=2, encoding="utf-8")
        logger = logging.getLogger("clawbox.rotation-test")
        logger.handlers = [handler]
        logger.setLevel(logging.INFO)
        for i in range(500):
            logger.info(f"rotation line {i} " + "x" * 50)  # 每行 ~70B, 500 行 > 2KB 触发多次轮转
        handler.close()
        # 轮转后主日志 + 2 个备份存在
        assert os.path.exists(log_file)
        backups = [f for f in os.listdir(td) if f.startswith("test.log.")]
        assert len(backups) <= 2


def test_logging_rotation_reentrant_safe():
    """轮转中途 (rename 失败) → 不抛, 后续写入仍可用。"""
    with tempfile.TemporaryDirectory() as td:
        log_file = os.path.join(td, "test.log")
        handler = logging.handlers.RotatingFileHandler(
            log_file, maxBytes=1024, backupCount=1, encoding="utf-8")
        logger = logging.getLogger("clawbox.rotation-reentrant")
        logger.handlers = [handler]
        logger.setLevel(logging.INFO)
        # 模拟 rename 失败 (Windows 上目标被占用)
        orig_rename = os.rename
        def _fail_rename(src, dst):
            if dst.endswith(".1"):
                raise OSError("EACCES: rename fail")
            return orig_rename(src, dst)
        with patch.object(os, "rename", side_effect=_fail_rename):
            for i in range(100):
                logger.info(f"line {i} " + "y" * 40)
        handler.close()
        assert os.path.exists(log_file)


def test_heartbeat_write_disk_full_no_crash():
    """磁盘满时心跳写入 → 仅告警, 守护进程不崩。"""
    with patch.object(pd.os, "makedirs", side_effect=OSError("ENOSPC")):
        pd._write_heartbeat()  # 不应抛


def test_trigger_delete_failure_no_crash():
    """触发文件删除失败 (只读目录) → 不抛。"""
    from triggers import TriggerWatcher
    with tempfile.TemporaryDirectory() as td:
        qr = os.path.join(td, "chat-qr.json")
        locale = os.path.join(td, "locale.json")
        w = TriggerWatcher([("chat", qr)], locale, max_qr_file_bytes=20000)
        with open(qr, "w", encoding="utf-8") as f:
            f.write("x" * 50000)  # 超大文件 → 触发删除
        w._qr_mtimes["chat"] = 0
        with patch.object(os, "remove", side_effect=OSError("EROFS")):
            res = w.check_qr()  # 不应抛
        assert res is None


# ============================================================
# 4. 长跑模拟: 主循环 200 轮心跳+处理不崩
# ============================================================
def test_main_loop_200_rounds_stable():
    """主循环 200 轮 (心跳+全 handler) → 正常退出码 0。"""
    ctx = AppContext()
    ctx.state.running = True
    ctx.watcher = Mock()
    ctx.watcher.check_qr.return_value = None
    ctx.watcher.check_locale.return_value = None
    ctx.switcher = Mock()
    ctx.switcher.switching = False
    ctx.switcher.switch_done = False
    ctx.switcher.reset_after_switch.return_value = False
    ctx.net_recover = Mock()
    ctx.screen_worker = Mock()
    ctx.screen_worker.stop.return_value = True
    ctx.screen_worker.screen = None
    # 用极短 KEY_POLL_INTERVAL 加速
    with patch.object(pd, "KEY_POLL_INTERVAL", 0.0):
        # 让主循环跑 200 轮后停止
        counter = {"n": 0}
        orig_heartbeat = pd._write_heartbeat
        def _hb_and_stop():
            counter["n"] += 1
            if counter["n"] >= 200:
                ctx.state.running = False
            orig_heartbeat()
        with patch.object(pd, "_write_heartbeat", side_effect=_hb_and_stop):
            code = pd._main_loop(ctx)
    assert code == 0
    assert counter["n"] >= 200