"""第二轮极端压力 — QR/电源/自恢复/文件系统/日志，全部 Mock 不碰硬件"""
import os, sys, json, time, threading, tempfile, base64, io
from unittest.mock import Mock, MagicMock, patch
_HERE = os.path.dirname(os.path.abspath(__file__))
_PERIPHERAL = os.path.join(os.path.dirname(_HERE), "clawbox-peripheral")
if _PERIPHERAL not in sys.path:
    sys.path.insert(0, _PERIPHERAL)

def test_qr_generator_malformed_data_urls():
    from qr_generator import data_url_to_image, generate_qr
    # 非法 data url 不应抛异常
    bads = ["", "data:image/png;base64,", "data:image/png;base64,!!!", "data:text/plain;base64,abc",
            "data:image/png;base64," + "A"*5 + "!!!", None, 123, "http://example.com"]
    for b in bads:
        try:
            r = data_url_to_image(b)
            assert r is None or hasattr(r, "size")
        except Exception as e:
            assert False, f"data_url_to_image 抛异常 {b!r}: {e}"
    # 合法但超小图片
    tiny_png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
    assert data_url_to_image("data:image/png;base64,"+tiny_png_b64) is not None
    # generate_qr 边界
    assert generate_qr("") is None
    assert generate_qr("   ") is None
    assert generate_qr(None) is None
    # 超长 data 应返回 None 而非崩
    assert generate_qr("x"*10000) is None or generate_qr("x"*10000).size[0] > 0  # qrcode 可能版本溢出返回 None
    # 正常
    img = generate_qr("https://example.com")
    assert img is not None

def test_qr_data_url_truncated_b64():
    from qr_generator import data_url_to_image
    # 截断的 base64（去掉末尾）不应崩
    b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8"
    assert data_url_to_image("data:image/png;base64,"+b64) is None

def test_trigger_symlink_and_dir():
    from triggers import TriggerWatcher
    with tempfile.TemporaryDirectory() as td:
        qr = os.path.join(td, "chat-qr.json")
        locale = os.path.join(td, "locale.json")
        w = TriggerWatcher([("chat", qr)], locale, max_qr_file_bytes=20000)
        # qr 指向目录
        os.mkdir(os.path.join(td, "adir"))
        if os.path.exists(qr):
            os.remove(qr)
        try:
            os.symlink(os.path.join(td, "adir"), qr)
        except OSError:
            return  # Windows 无权限跳过
        w._qr_mtimes["chat"] = 0
        try:
            w.check_qr()
        except Exception as e:
            assert False, f"symlink dir 不应抛: {e}"
        # 清理
        try: os.remove(qr)
        except: pass

def test_trigger_permission_error():
    from triggers import TriggerWatcher
    with tempfile.TemporaryDirectory() as td:
        qr = os.path.join(td, "chat-qr.json")
        locale = os.path.join(td, "locale.json")
        w = TriggerWatcher([("chat", qr)], locale, max_qr_file_bytes=20000)
        # 先创建文件，再在 patch 期间让后续 open 抛 PermissionError
        with open(qr, "w", encoding="utf-8") as f:
            f.write('{"qr_url":"https://example.com"}')
        w._qr_mtimes["chat"] = 0
        with patch("builtins.open", side_effect=PermissionError("denied")):
            # _read_qr_trigger 内部会捕获 OSError 并尝试删除文件
            try:
                w.check_qr()
            except PermissionError:
                assert False, "不应把 PermissionError 抛到外层"

def test_net_auto_recover_manual_ap_priority():
    from net_auto_recover import NetworkAutoRecover
    switcher = Mock(); switcher.busy = False
    r = NetworkAutoRecover(switcher, grace_s=5, client_stable_s=10, ap_client_grace_s=600, poll_s=0.1)
    # 手动热点时应立即取消恢复
    r._recovering = True
    r._lost_since = time.monotonic() - 10
    r.check(client_connected=False, manual_ap=True, now=time.monotonic())
    assert r._recovering is False or r._cancel.is_set()
    assert r._lost_since is None

def test_net_auto_recover_grace_not_expired():
    from net_auto_recover import NetworkAutoRecover
    switcher = Mock(); switcher.busy = False
    r = NetworkAutoRecover(switcher, grace_s=5, client_stable_s=10, ap_client_grace_s=600, poll_s=0.1)
    now = time.monotonic()
    r.check(False, False, now)
    assert r._lost_since == now
    # 1秒后未到 grace 不应启动恢复
    r.check(False, False, now+1)
    assert r._recovering is False

def test_power_shutdown_respects_screen_busy():
    import power
    state = Mock(); state.cached = {}; state.led = None; state.running = True
    worker = Mock()
    worker.screen = Mock(); worker.screen.available = True; worker.screen.clear = Mock()
    # 模拟 screen_worker.stop 超时返回 False (BUSY)
    worker.stop.return_value = False
    with patch("power.subprocess.run") as mock_run:
        mock_run.return_value = Mock(returncode=0)
        try:
            power.do_shutdown(state, worker)
        except SystemExit:
            pass
        except Exception as e:
            assert False, f"do_shutdown 不应抛: {e}"
        # 即使 BUSY，也应已发起关机（power.py 先 run 再 stop）
        assert mock_run.called
        # BUSY 时应跳过清屏
        worker.screen.clear.assert_not_called()

def test_api_client_concurrent_requests():
    from api_client import ApiClient
    import urllib.request
    # 并发 20 线程同时 GET，不应死锁
    cli = ApiClient("http://127.0.0.1:80", timeout=0.5)
    errs=[]
    def hammer():
        for _ in range(10):
            try:
                with patch("api_client.urlopen", side_effect=Exception("boom")):
                    cli.get_setup_status(timeout=0.2)
            except Exception as e:
                errs.append(e)
    threads=[threading.Thread(target=hammer) for _ in range(5)]
    for t in threads: t.start()
    for t in threads: t.join(timeout=5)
    assert not errs

def test_status_local_fallback_when_api_error_dict():
    from daemon_state import DaemonState
    from status import update_status_from_api
    state = DaemonState()
    class ErrApi:
        def get_setup_status(self, timeout=None): return {"_error":"down"}
        def get_wifi_status(self, timeout=None): return {"_error":"down"}
        def get_system_info(self, timeout=None): return {"_error":"down"}
    state.api = ErrApi()
    with patch("status.detect_wifi_mode", return_value="client"), \
         patch("status.get_local_wifi_ssid", return_value="ssid"), \
         patch("status.get_local_ip", return_value="1.2.3.4"), \
         patch("status.get_local_hostname", return_value="host"), \
         patch("status.local_network_mode", return_value=""):
        update_status_from_api(state)
        assert state.cached["wifi_ip"] == "1.2.3.4"

def test_trigger_locale_invalid_not_deleted():
    from triggers import TriggerWatcher
    with tempfile.TemporaryDirectory() as td:
        qr = os.path.join(td, "chat-qr.json")
        locale = os.path.join(td, "locale.json")
        w = TriggerWatcher([("chat", qr)], locale, max_qr_file_bytes=20000)
        # 写非法 locale
        with open(locale, "w", encoding="utf-8") as f:
            json.dump({"locale": ""}, f)
        w._locale_mtime = 0
        res = w.check_locale()
        assert res is None
        assert os.path.exists(locale), "非法 locale 不应被删除"
        # 再次写合法应能恢复
        with open(locale, "w", encoding="utf-8") as f:
            json.dump({"locale": "en"}, f)
        os.utime(locale, None)
        # 强制更新 mtime
        time.sleep(0.01)
        os.utime(locale, (time.time()+1, time.time()+1))
        res = w.check_locale()
        assert res == "en"

def test_screen_worker_many_small_images_memory():
    from screen_worker import ScreenWorker
    from PIL import Image
    screen = Mock(); screen.show_page = Mock()
    w = ScreenWorker(screen=screen)
    w.start()
    for i in range(100):
        img = Image.new("1", (152,152), 1)
        w.request(i%5, img)
    time.sleep(0.5)
    # 不应泄漏 pending 队列无限增长（只保留最后一张）
    assert w._pending_image is not None
    w.stop(timeout=1)
    assert w.stop(timeout=1) is True
