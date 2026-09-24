"""第五轮极端压力 — 外部依赖挂起 / 组合风暴 / 渲染极端 (2026-08-26)。

覆盖 8.26 审查盲区第三四五梯队: API 卡死 / 子进程挂起 / 时间跳变 /
全模块组合风暴 / 网络状态机横跳 / 按键风暴 / 多实例竞争 / 渲染极端 /
PIL 解压炸弹 / locale 极端。
全部 Mock, 不碰真实硬件/网络/板子。
运行: D:/python_env/Scripts/python.exe -m pytest tests/test_stress_external.py -v
"""
import os
import sys
import time
import json
import base64
import threading
import tempfile
import pytest
from unittest.mock import Mock, patch

_HERE = os.path.dirname(os.path.abspath(__file__))
_PERIPHERAL = os.path.join(os.path.dirname(_HERE), "clawbox-peripheral")
if _PERIPHERAL not in sys.path:
    sys.path.insert(0, _PERIPHERAL)

import peripheral_daemon as pd
from app_context import AppContext


def _make_ctx(**overrides):
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
    for k, v in overrides.items():
        setattr(ctx, k, v)
    return ctx


# ============================================================
# 1. API 永不返回 (timeout 失效) → 主循环不受影响
# ============================================================
def test_status_poll_loop_api_hang_does_not_block_main_loop():
    """API 卡死 (永不返回) → status 线程卡住, 主循环仍正常跑。"""
    from status import status_poll_loop
    from daemon_state import DaemonState
    st = DaemonState()
    st.api = Mock()
    # get_setup_status 永不返回 (模拟 timeout 失效)
    def _hang(*a, **kw):
        time.sleep(30)
    st.api.get_setup_status.side_effect = _hang
    st.api.get_wifi_status.side_effect = _hang
    st.api.get_system_info.side_effect = _hang
    t = threading.Thread(target=status_poll_loop, args=(st, st.status_stop, 0.05), daemon=True)
    t.start()
    time.sleep(0.3)
    # 主循环仍能跑 (状态线程卡住不影响)
    ctx = _make_ctx()
    ctx.state.running = True
    t2 = threading.Thread(target=lambda: (time.sleep(0.1), setattr(ctx.state, "running", False)))
    t2.daemon = True
    t2.start()
    code = pd._main_loop(ctx)
    assert code == 0
    st.status_stop.set()
    t.join(timeout=1)


def test_status_poll_loop_api_raises_every_call():
    """API 每轮都抛异常 → 状态线程不崩, 缓存保持。"""
    from status import status_poll_loop
    from daemon_state import DaemonState
    st = DaemonState()
    st.api = Mock()
    st.api.get_setup_status.side_effect = RuntimeError("boom")
    st.api.get_wifi_status.side_effect = RuntimeError("boom")
    st.api.get_system_info.side_effect = RuntimeError("boom")
    t = threading.Thread(target=status_poll_loop, args=(st, st.status_stop, 0.02), daemon=True)
    t.start()
    time.sleep(0.3)
    assert t.is_alive()  # 线程没死
    st.status_stop.set()
    t.join(timeout=1)
    assert not t.is_alive()


# ============================================================
# 2. 子进程挂起 → 主循环阻塞检测
# ============================================================
def test_net_utils_subprocess_hang_has_timeout():
    """net_utils._run_stdout 有 timeout → 挂起子进程被杀死, 不永久阻塞。"""
    from net_utils import _run_stdout
    start = time.monotonic()
    out = _run_stdout(["python", "-c", "import time; time.sleep(30)"], timeout=0.5)
    elapsed = time.monotonic() - start
    assert elapsed < 5, f"子进程挂起未超时: {elapsed:.1f}s"
    assert out == ""


def test_main_loop_survives_slow_net_recover():
    """net_recover.check 慢 (2s) → 主循环不崩, 只是该轮变慢。"""
    ctx = _make_ctx()
    ctx.net_recover.check.side_effect = lambda *a, **kw: time.sleep(0.2)
    ctx.state.running = True
    t = threading.Thread(target=lambda: (time.sleep(0.5), setattr(ctx.state, "running", False)))
    t.daemon = True
    t.start()
    code = pd._main_loop(ctx)
    assert code == 0


# ============================================================
# 3. 时间跳变 (NTP 同步) → QR 过期/心跳 age 不误判崩溃
# ============================================================
def test_qr_expiry_time_jump_forward():
    """墙钟向前跳 1 小时 → QR 过期检测正常触发, 不崩。"""
    ctx = _make_ctx()
    ctx.state.current_page = 2
    ctx.state.cached["chat_qr_type"] = "image"
    ctx.state.cached["chat_qr_platform"] = "whatsapp"
    ctx.state.cached["chat_qr_updated_at"] = time.time() - 3600  # 1 小时前
    pages = []
    with patch.object(pd, "QR_EXPIRE_MS", 30000):
        pd._handle_qr_expiry(ctx.state, lambda p: pages.append(p))
    assert pages == [pd.PAGE_QR_EXPIRED]


def test_qr_expiry_time_jump_backward():
    """墙钟向后跳 1 小时 → 不误判过期, 不崩。"""
    ctx = _make_ctx()
    ctx.state.current_page = 2
    ctx.state.cached["chat_qr_type"] = "image"
    ctx.state.cached["chat_qr_platform"] = "whatsapp"
    ctx.state.cached["chat_qr_updated_at"] = time.time() + 3600  # 未来 1 小时
    pages = []
    with patch.object(pd, "QR_EXPIRE_MS", 30000):
        pd._handle_qr_expiry(ctx.state, lambda p: pages.append(p))
    assert pages == []  # 未来时间戳 → 未过期


def test_qr_expiry_missing_timestamp():
    """chat_qr_updated_at 缺失/为 0 → 不触发过期, 不崩。"""
    ctx = _make_ctx()
    ctx.state.current_page = 2
    ctx.state.cached["chat_qr_type"] = "image"
    ctx.state.cached["chat_qr_platform"] = "whatsapp"
    ctx.state.cached["chat_qr_updated_at"] = 0.0
    pages = []
    pd._handle_qr_expiry(ctx.state, lambda p: pages.append(p))
    assert pages == []


# ============================================================
# 4. 全模块组合风暴 (所有 handler 高频触发)
# ============================================================
def test_combined_storm_100_rounds():
    """按键+QR+locale+网络+状态+LED 同时高频触发 100 轮 → 主循环不崩。"""
    ctx = _make_ctx()
    ctx.state.keys = Mock()
    ctx.state.keys.poll.side_effect = lambda: None
    ctx.state.obtn = Mock()
    ctx.state.obtn.poll.side_effect = lambda: None
    ctx.state.led = Mock()
    # QR 每轮都来新码
    qr_counter = {"n": 0}
    def _qr(*a, **kw):
        qr_counter["n"] += 1
        return {"qr_url": f"https://example.com/{qr_counter['n']}",
                "platform": "wechat", "qr_type": "url"}
    ctx.watcher.check_qr.side_effect = _qr
    # locale 每轮都变
    locale_counter = {"n": 0}
    def _locale(*a, **kw):
        locale_counter["n"] += 1
        return f"lang-{locale_counter['n'] % 5}"
    ctx.watcher.check_locale.side_effect = _locale
    # 网络切换每轮完成
    ctx.switcher.reset_after_switch.side_effect = lambda: True
    # 状态每轮变化
    ctx.state.cached["wifi_mode"] = "client"
    ctx.state.cached["wifi_ip"] = "192.168.1.100"
    ctx.state.cached["wifi_ssid"] = "StormSSID"
    counter = {"n": 0}
    orig_hb = pd._write_heartbeat
    def _hb():
        counter["n"] += 1
        if counter["n"] >= 100:
            ctx.state.running = False
        orig_hb()
    with patch.object(pd, "_write_heartbeat", side_effect=_hb), \
         patch.object(pd, "KEY_POLL_INTERVAL", 0.0), \
         patch.object(pd, "gen_and_request", return_value=None):
        code = pd._main_loop(ctx)
    assert code == 0
    assert qr_counter["n"] >= 100
    assert locale_counter["n"] >= 100


# ============================================================
# 5. 网络状态机横跳
# ============================================================
def test_switcher_rapid_toggle_no_crash():
    """NetworkSwitcher.on_button 高频横跳 50 次 → 不崩, 状态一致。

    mock subprocess.run: 避免真正执行 network_action.sh (Windows 上 Git Bash
    输出 UTF-8 中文, GBK 解码失败产生 reader 线程异常噪音, 2026-08-26)。
    """
    from net_switcher import NetworkSwitcher
    sw = NetworkSwitcher(led=None)
    with patch("net_switcher.subprocess.run", return_value=Mock(returncode=0, stdout="", stderr="")):
        for i in range(50):
            mode = "ap" if i % 2 == 0 else "client"
            sw.on_button(mode, "press")
    sw.cleanup()


def test_switcher_on_button_while_busy():
    """切换进行中再次按键 → 忙锁忽略, 不崩。"""
    from net_switcher import NetworkSwitcher
    sw = NetworkSwitcher(led=None)
    with patch("net_switcher.subprocess.run", return_value=Mock(returncode=0, stdout="", stderr="")):
        sw.on_button("client", "press")  # 启动切换
        sw.on_button("ap", "press")      # 忙中再按 → 忽略
    sw.cleanup()


# ============================================================
# 6. 按键风暴
# ============================================================
def test_key_callback_storm():
    """按键回调高频触发 200 次 (含 K4 重启/关机路径) → 不崩。"""
    from daemon_state import DaemonState
    ctx = _make_ctx()
    ctx.state = DaemonState()
    ctx.state.running = True
    with patch.object(pd, "do_reboot"), patch.object(pd, "do_shutdown"), \
         patch.object(pd, "gen_and_request"):
        for i in range(200):
            key = f"k{i % 4 + 1}"
            event = "press" if i % 2 == 0 else "long"
            pd.on_key_event(ctx, key, event)  # 不应抛


def test_onboard_button_storm():
    """板载按键回调高频触发 100 次 → 不崩。"""
    ctx = _make_ctx()
    ctx.switcher = Mock()
    ctx.net_recover = Mock()
    for i in range(100):
        pd.on_onboard_button(ctx, "pb7", "press")  # 不应抛


# ============================================================
# 7. 多实例竞争 (peripheral_lock)
# ============================================================
class _FakeFcntl:
    """Windows 上模拟 fcntl.flock 语义 (按文件路径排他锁, EAGAIN=已被占)。

    真实 flock 按 inode 锁: 同一文件被第二个 fd 打开时 flock 会 EAGAIN。
    这里用 fd→path 映射模拟, 需要配合 monkeypatch os.open 记录路径。
    """

    def __init__(self):
        self._locked_paths = set()
        self._fd_paths = {}

    def register_fd(self, fd, path):
        self._fd_paths[fd] = path

    def unregister_fd(self, fd):
        self._fd_paths.pop(fd, None)

    def flock(self, fd, op):
        import errno
        path = self._fd_paths.get(fd)
        if op & 2:  # LOCK_UN
            if path is not None:
                self._locked_paths.discard(path)
            return
        if path is not None and path in self._locked_paths:
            raise OSError(errno.EAGAIN, "Resource temporarily unavailable")
        if path is not None:
            self._locked_paths.add(path)


@pytest.fixture()
def fake_fcntl(monkeypatch):
    """注入假 fcntl 模块 + os.open 路径记录, 让 peripheral_lock 可在 Windows 上测试。"""
    import types
    fake = _FakeFcntl()
    mod = types.ModuleType("fcntl")
    mod.flock = fake.flock
    mod.LOCK_EX = 1
    mod.LOCK_NB = 4
    mod.LOCK_UN = 2
    monkeypatch.setitem(sys.modules, "fcntl", mod)
    # 记录 os.open 的 fd→path, 并在 os.close 时清理
    real_open = os.open
    real_close = os.close

    def _open(path, flags, mode=0o777, **kw):
        fd = real_open(path, flags, mode, **kw)
        fake.register_fd(fd, os.fspath(path))
        return fd

    def _close(fd):
        fake.unregister_fd(fd)
        real_close(fd)

    monkeypatch.setattr(os, "open", _open)
    monkeypatch.setattr(os, "close", _close)
    return fake


def test_daemon_lock_double_acquire_rejected(fake_fcntl):
    """同一进程内双实例抢锁 → 第二个 acquire 返回 False。"""
    from peripheral_lock import DaemonLock
    with tempfile.TemporaryDirectory() as td:
        lock_path = os.path.join(td, "test.lock")
        l1 = DaemonLock(lock_path)
        l2 = DaemonLock(lock_path)
        assert l1.acquire() is True
        assert l2.acquire() is False  # 双实例被拒
        l1.release()
        assert l2.acquire() is True   # 释放后可再获取
        l2.release()


def test_daemon_lock_release_idempotent(fake_fcntl):
    """release 重复调用 → 不抛。"""
    from peripheral_lock import DaemonLock
    with tempfile.TemporaryDirectory() as td:
        lock_path = os.path.join(td, "test.lock")
        l1 = DaemonLock(lock_path)
        assert l1.acquire() is True
        l1.release()
        l1.release()  # 第二次不抛


# ============================================================
# 8. 渲染极端数据
# ============================================================
def test_render_extreme_ssid_and_ip():
    """超长 SSID (255B) / 超长 IP → 渲染不崩。"""
    from page_render import render_page_image
    from daemon_state import DaemonState
    st = DaemonState()
    st.cached["wifi_mode"] = "client"
    st.cached["wifi_ssid"] = "S" * 255
    st.cached["wifi_ip"] = "I" * 100
    st.cached["hostname"] = "H" * 100
    st.cached["chat_qr_url"] = "https://example.com/" + "x" * 500
    st.cached["chat_qr_platform"] = "wechat"
    st.cached["chat_qr_type"] = "url"
    st.cached["locale"] = "zh-CN"
    for page in range(4):
        img = render_page_image(st, page)  # 不应抛
        assert img is not None


def test_render_all_locales_roundtrip():
    """21 语言全量切换渲染 → 不崩。"""
    from page_render import render_page_image
    from screen_pages import resolve_screen_locale, set_locale
    from daemon_state import DaemonState
    locales = ["zh-CN", "zh-TW", "en", "ja", "ko", "ru", "es", "fr", "de",
               "it", "pt", "ar", "hi", "th", "vi", "id", "tr", "pl", "nl",
               "sv", "he"]
    for loc in locales:
        resolved = resolve_screen_locale(loc)
        set_locale(resolved)
        st = DaemonState()
        st.cached["locale"] = resolved
        st.cached["wifi_mode"] = "client"
        st.cached["wifi_ssid"] = "Test"
        st.cached["wifi_ip"] = "192.168.1.1"
        st.cached["hostname"] = "clawbox"
        st.cached["chat_qr_url"] = "https://example.com"
        st.cached["chat_qr_platform"] = "wechat"
        st.cached["chat_qr_type"] = "url"
        for page in range(4):
            img = render_page_image(st, page)  # 不应抛
            assert img is not None


def test_render_rtl_mixed_text():
    """RTL 语言 (阿拉伯语) 混合文本渲染 → 不崩。"""
    from page_render import render_page_image
    from screen_pages import resolve_screen_locale, set_locale
    from daemon_state import DaemonState
    set_locale(resolve_screen_locale("ar"))
    st = DaemonState()
    st.cached["locale"] = "ar"
    st.cached["wifi_mode"] = "client"
    st.cached["wifi_ssid"] = "WiFi-شبكة-测试"
    st.cached["wifi_ip"] = "192.168.1.1"
    st.cached["hostname"] = "clawbox"
    st.cached["chat_qr_url"] = "https://example.com"
    st.cached["chat_qr_platform"] = "wechat"
    st.cached["chat_qr_type"] = "url"
    for page in range(4):
        img = render_page_image(st, page)  # 不应抛
        assert img is not None


# ============================================================
# 9. PIL 解压炸弹
# ============================================================
def test_qr_decompression_bomb_guarded():
    """QR 图片解压炸弹 (极小文件声明巨大尺寸) → 不崩不 OOM。"""
    from qr_generator import data_url_to_image
    # 构造 PNG: 1x1 像素但 IHDR 声明 100000x100000 (解压炸弹)
    # 用 PIL 生成合法小图, 再篡改 IHDR 尺寸
    from PIL import Image
    import io
    img = Image.new("RGB", (1, 1), (0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    png = bytearray(buf.getvalue())
    # IHDR 尺寸在偏移 16-23 (宽 16-19, 高 20-23), 篡改为 100000
    png[16:20] = (100000).to_bytes(4, "big")
    png[20:24] = (100000).to_bytes(4, "big")
    b64 = base64.b64encode(bytes(png)).decode()
    try:
        result = data_url_to_image("data:image/png;base64," + b64)
        # 要么被拒绝返回 None, 要么 PIL 报错被吞, 要么成功 (小图)
        assert result is None or hasattr(result, "size")
    except Exception as e:
        assert False, f"解压炸弹不应抛异常: {e}"


# ============================================================
# 10. locale.json 极端
# ============================================================
def test_locale_trigger_extreme_values():
    """locale 触发文件极端值 (损坏/GBK 字节/超大) → 不崩。"""
    from triggers import TriggerWatcher
    with tempfile.TemporaryDirectory() as td:
        qr = os.path.join(td, "chat-qr.json")
        locale = os.path.join(td, "locale.json")
        w = TriggerWatcher([("chat", qr)], locale, max_qr_file_bytes=20000)
        w.sync_locale_mtime()
        # 损坏 JSON
        with open(locale, "w", encoding="utf-8") as f:
            f.write("{broken")
        w._locale_mtime = 0
        r = w.check_locale()  # 不应抛
        # GBK 字节
        with open(locale, "wb") as f:
            f.write(b"\xba\xba\xba\xba")  # GBK 乱码
        w._locale_mtime = 0
        r = w.check_locale()  # 不应抛
        # 超大文件
        with open(locale, "w", encoding="utf-8") as f:
            f.write("x" * 100000)
        w._locale_mtime = 0
        r = w.check_locale()  # 不应抛
        # 合法但未知语言
        with open(locale, "w", encoding="utf-8") as f:
            json.dump({"locale": "xx-XX"}, f)
        w._locale_mtime = 0
        r = w.check_locale()  # 不应抛
        assert r is None or isinstance(r, str)