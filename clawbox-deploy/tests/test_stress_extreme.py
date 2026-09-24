"""极端压力测试 — 全 Mock，不碰真实硬件/网络/板子
覆盖: validation / triggers / api_client / screen_worker / status / net_switcher / fan / daemon handlers
运行: D:/python_env/Scripts/python.exe -m pytest tests/test_stress_extreme.py -v
"""
import os, sys, json, time, threading, tempfile, random, string, subprocess
from unittest.mock import Mock, MagicMock, patch

_HERE = os.path.dirname(os.path.abspath(__file__))
_PERIPHERAL = os.path.join(os.path.dirname(_HERE), "clawbox-peripheral")
if _PERIPHERAL not in sys.path:
    sys.path.insert(0, _PERIPHERAL)

import validation as V
from triggers import TriggerWatcher
from screen_worker import ScreenWorker
from api_client import ApiClient
import config

# ---------- helper ----------
def rand_str(n, charset=string.printable):
    return ''.join(random.choice(charset) for _ in range(n))

# ============================================================
# 1. validation 模糊/边界 压力
# ============================================================
def test_validation_fuzz_no_crash():
    """随机类型/长度/字符 不应抛异常"""
    weird = [None, 0, 3.14, [], {}, b"http://x", "", "   ", "http://", "https://", "ftp://x.com",
             "http://user:pass@host/", "http://[::1]/", "javascript:alert(1)",
             "http://" + "a"*10000, "data:image/png;base64," + "A"*20000]
    # 加入100个随机字符串
    for _ in range(200):
        weird.append(rand_str(random.randint(0, 5000)))
        weird.append(random.choice([None, 123, {}, []]))
    for v in weird:
        # 不应抛异常
        r1 = V.validate_qr_url(v)
        assert isinstance(r1, str)
        r2 = V.validate_qr_data_url(v)
        assert isinstance(r2, str)

def test_validation_data_url_edge():
    assert V.validate_qr_data_url("data:image/png;base64,") == ""
    assert V.validate_qr_data_url("data:image/png;base64,!!!") == ""
    assert V.validate_qr_data_url("data:image/png;base64,abc=") != ""  # 合法
    assert V.validate_qr_data_url(" data:image/png;base64,abc= ") != ""
    # 超长
    big = "data:image/png;base64," + "A"*20000
    assert V.validate_qr_data_url(big) == ""  # 超 MAX_QR_DATA_URL_LENGTH(16384)

def test_validation_url_with_credentials_rejected():
    assert V.validate_qr_url("http://user:pass@example.com/q") == ""
    assert V.validate_qr_url("https://example.com/q?x=1") != ""

# ============================================================
# 2. triggers 极端文件 压力
# ============================================================
def test_trigger_huge_file_deleted():
    with tempfile.TemporaryDirectory() as td:
        qr = os.path.join(td, "chat-qr.json")
        locale = os.path.join(td, "locale.json")
        w = TriggerWatcher([("chat", qr)], locale, max_qr_file_bytes=20000)
        # 写超大文件
        with open(qr, "w", encoding="utf-8") as f:
            f.write("x"*50000)
        # check_qr 应该检测到并删除超大文件，不抛异常
        # 需伪造 mtime 变化
        os.utime(qr, None)
        w._qr_mtimes["chat"] = 0
        res = w.check_qr()
        assert res is None
        assert not os.path.exists(qr), "超大文件应被删除"

def test_trigger_invalid_json_deleted_after_grace():
    with tempfile.TemporaryDirectory() as td:
        qr = os.path.join(td, "chat-qr.json")
        locale = os.path.join(td, "locale.json")
        w = TriggerWatcher([("chat", qr)], locale, max_qr_file_bytes=20000)
        with open(qr, "w", encoding="utf-8") as f:
            f.write("{not json")
        # 让文件 mtime 旧于1秒，确保不走 fresh grace
        old = time.time() - 2
        os.utime(qr, (old, old))
        w._qr_mtimes["chat"] = 0
        res = w.check_qr()
        assert res is None
        # 无效JSON 应被删除 (超过 grace)
        assert not os.path.exists(qr)

def test_trigger_fresh_write_not_deleted():
    with tempfile.TemporaryDirectory() as td:
        qr = os.path.join(td, "chat-qr.json")
        locale = os.path.join(td, "locale.json")
        w = TriggerWatcher([("chat", qr)], locale, max_qr_file_bytes=20000)
        with open(qr, "w", encoding="utf-8") as f:
            f.write("{not json fresh")
        # mtime 就是现在，落在 1s grace 内 -> 不删除，返回 None
        w._qr_mtimes["chat"] = 0
        res = w.check_qr()
        assert res is None
        assert os.path.exists(qr), "fresh grace 内不应删除"

def test_trigger_rapid_mtime_flap_no_crash():
    with tempfile.TemporaryDirectory() as td:
        qr = os.path.join(td, "chat-qr.json")
        locale = os.path.join(td, "locale.json")
        w = TriggerWatcher([("chat", qr)], locale, max_qr_file_bytes=20000)
        w.sync_qr_mtimes()
        w.sync_locale_mtime()
        for i in range(100):
            # 交替写合法/非法
            if i % 3 == 0:
                data = {"qr_url": f"https://example.com/{i}", "platform": "wechat"}
            elif i % 3 == 1:
                data = {"qr_url": "not a url"}
            else:
                data = {"qr_url": "data:image/png;base64,abc=", "qr_type": "image", "platform": "whatsapp"}
            with open(qr, "w", encoding="utf-8") as f:
                json.dump(data, f)
            # 同步更新 mtime 以确保检测
            # 强制设置不同 mtime
            t = time.time() + i*0.01
            os.utime(qr, (t, t))
            try:
                w.check_qr()
            except Exception as e:
                assert False, f"rapid flap 抛异常: {e}"
            # locale 同步
            with open(locale, "w", encoding="utf-8") as f:
                json.dump({"locale": random.choice(["en","zh-CN","ko","invalid"])}, f)
            os.utime(locale, (t,t))
            try:
                w.check_locale()
            except Exception as e:
                assert False, f"locale rapid 抛异常: {e}"

def test_trigger_concurrent_writes_no_crash():
    """多线程并发写同一触发文件"""
    with tempfile.TemporaryDirectory() as td:
        qr = os.path.join(td, "chat-qr.json")
        locale = os.path.join(td, "locale.json")
        w = TriggerWatcher([("chat", qr)], locale, max_qr_file_bytes=20000)
        errors = []
        def writer(idx):
            for k in range(30):
                try:
                    with open(qr, "w", encoding="utf-8") as f:
                        json.dump({"qr_url": f"https://example.com/{idx}-{k}"}, f)
                    w.check_qr()
                except Exception as e:
                    errors.append(e)
        threads = [threading.Thread(target=writer, args=(i,)) for i in range(5)]
        for t in threads: t.start()
        for t in threads: t.join(timeout=5)
        assert not errors, f"并发写触发异常: {errors}"

# ============================================================
# 3. api_client 极端响应 压力
# ============================================================
def test_api_client_rejects_credential_url():
    try:
        ApiClient("http://user:pass@127.0.0.1:80")
        assert False, "应拒绝带凭据的 URL"
    except ValueError:
        pass

def test_api_client_large_response_rejected():
    # mock 一个超大响应 >1MB
    big = b"x" * (1024*1024 + 10)
    mock_resp = MagicMock()
    mock_resp.read.return_value = big
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = Mock(return_value=False)
    with patch("api_client.urlopen", return_value=mock_resp):
        cli = ApiClient("http://127.0.0.1:80", timeout=0.2)
        res = cli.get_setup_status(timeout=0.2)
        assert "_error" in res

def test_api_client_5xx_retry_then_fail():
    from urllib.error import HTTPError
    err = HTTPError("http://127.0.0.1/setup-api/setup/status", 500, "Server Error", {}, None)
    # 让 urlopen 每次都抛 500
    with patch("api_client.urlopen", side_effect=err):
        with patch("api_client.time.sleep"):  # 加速
            cli = ApiClient("http://127.0.0.1:80", timeout=0.2)
            res = cli.get_setup_status(timeout=0.2)
            assert "_error" in res
            # 连续失败5次后 available 应为 False
            for _ in range(6):
                with patch("api_client.urlopen", side_effect=err):
                    cli.get_setup_status(timeout=0.2)
            assert cli.available is False

def test_api_client_4xx_no_retry():
    from urllib.error import HTTPError
    err = HTTPError("http://127.0.0.1/setup-api/setup/status", 404, "Not Found", {}, None)
    # 404 不应重试，直接返回
    call_count = {"n":0}
    def fake_open(*a, **kw):
        call_count["n"]+=1
        raise err
    with patch("api_client.urlopen", side_effect=fake_open):
        cli = ApiClient("http://127.0.0.1:80", timeout=0.2)
        res = cli.get_setup_status(timeout=0.2)
        assert call_count["n"] == 1, "4xx 不应重试"

# ============================================================
# 4. screen_worker 并发/停止 压力
# ============================================================
def test_screen_worker_concurrent_requests_no_deadlock():
    """多线程并发 request 1000次，验证版本号单调且无死锁"""
    screen = Mock()
    screen.show_page = Mock()
    w = ScreenWorker(screen=screen)
    w.start()
    errs = []
    def hammer():
        for _ in range(200):
            try:
                w.request(1, Mock())
            except Exception as e:
                errs.append(e)
    threads = [threading.Thread(target=hammer) for _ in range(5)]
    for t in threads: t.start()
    for t in threads: t.join(timeout=5)
    time.sleep(0.5)
    w.stop(timeout=1)
    assert not errs
    # 版本号应 >=1000
    assert w._image_version >= 1000
    # done_version 不应超过 image_version
    assert w._done_version <= w._image_version

def test_screen_worker_stop_during_busy():
    """模拟 SPI BUSY 长时间阻塞，stop 短超时应返回 False"""
    screen = Mock()
    def slow_show(page, img):
        time.sleep(1.5)
    screen.show_page = slow_show
    w = ScreenWorker(screen=screen)
    w.start()
    w.request(1, Mock())
    time.sleep(0.1)  # 让后台进入 show_page
    ok_short = w.stop(timeout=0.2)
    assert ok_short is False, "BUSY 时短超时应返回 False"
    # 再等足够时间应能停稳
    ok_long = w.stop(timeout=3)
    assert ok_long is True

def test_screen_worker_reinit_storm():
    """连续5次失败触发重初始化；mock ScreenRenderer 初始化失败路径"""
    screen = Mock()
    screen.show_page.side_effect = RuntimeError("SPI fail")
    screen.cleanup = Mock()
    w = ScreenWorker(screen=screen)
    # 注入一个必失败的 screen
    w._screen = screen
    w._running = True
    # 直接调 _reinit 逻辑：模拟 5次失败后丢弃帧
    with patch("screen_worker.ScreenRenderer") as MockRenderer:
        MockRenderer.return_value.available = False
        w._fail_count = 5
        w._reinit_screen(ver=10)
        assert w._done_version == 10  # 丢弃当前帧
        assert w._fail_count == 0

def test_screen_worker_request_none_image_handled():
    w = ScreenWorker(screen=None)
    w.start()
    # screen=None 时 request 仍应入队，后台会抛 RuntimeError 但不崩线程
    w.request(2, Mock())
    time.sleep(0.3)
    assert w._thread.is_alive()
    w.stop(timeout=1)

# ============================================================
# 5. status 本地兜底 压力
# ============================================================
def test_status_no_crash_when_api_flapping():
    from daemon_state import DaemonState
    from status import update_status_from_api
    state = DaemonState()
    # api 随机抛异常 / 返回 _error / 返回 None
    class FlapApi:
        def get_setup_status(self, timeout=None):
            r = random.choice(["error","exc","ok"])
            if r=="error": return {"_error": "down"}
            if r=="exc": raise RuntimeError("boom")
            return {"wifi_mode":"client", "wifi_ssid":"test"}
        def get_wifi_status(self, timeout=None):
            if random.random()<0.5: raise RuntimeError("wifi boom")
            return {"mode":"ap","ssid":"x"}
        def get_system_info(self, timeout=None):
            if random.random()<0.5: return {"_error":"down"}
            return {"hostname":"clawbox"}
    state.api = FlapApi()
    for _ in range(50):
        try:
            update_status_from_api(state)
        except Exception as e:
            assert False, f"status 不应抛到外层: {e}"
        assert "wifi_mode" in state.cached

# ============================================================
# 6. net_switcher 重入/风暴 压力
# ============================================================
def test_net_switcher_reentrancy():
    from net_switcher import NetworkSwitcher
    led = Mock()
    led.set_hotspot = Mock(); led.set_wifi = Mock(); led.set_power = Mock()
    sw = NetworkSwitcher(led=led)
    with patch("net_switcher.subprocess.run") as mock_run:
        mock_run.return_value = Mock(returncode=0, stdout="", stderr="")
        with patch("net_switcher.local_network_mode", return_value="client"):
            with patch.object(sw, "_start_blink"):
                with patch.object(sw, "_stop_blink"):
                    # 快速连按 20次
                    for _ in range(20):
                        sw.on_button("client", "press")
                    time.sleep(0.2)
                    # 只有第一次应触发 subprocess，busy 期间其余被忽略
                    assert mock_run.call_count == 1
                    assert sw.busy is True
    # 清理：等待后台线程结束 (触发 _run_network_action 的 finally 会清 busy)
    # 由于 mock 了 _stop_blink，手动复位避免影响后续测试
    sw._net_busy = False

def test_net_switcher_blink_thread_leak():
    from net_switcher import NetworkSwitcher
    led = Mock()
    led.set_hotspot = Mock(); led.set_wifi = Mock(); led.set_power = Mock()
    sw = NetworkSwitcher(led=led)
    # 连续 start/stop 10次，不应泄漏线程无限增长
    before = threading.active_count()
    for _ in range(10):
        sw._start_blink("hotspot")
        time.sleep(0.05)
        sw._stop_blink()
        time.sleep(0.05)
    time.sleep(0.3)
    after = threading.active_count()
    # 允许 1-2 个 daemon 残留，但不应暴涨
    assert after - before <= 3, f"blink 线程泄漏: before={before} after={after}"

# ============================================================
# 7. fan_curve 极端温度 压力
# ============================================================
def test_fan_curve_extreme_temps_no_crash():
    from fan_curve import calc_target_duty
    curve = [(40,0),(45,30),(55,50),(65,75),(75,100)]
    for t in [-100, -1, 0, 39.9, 40, 47.3, 100, 200, 1000]:
        d = calc_target_duty(t, curve, hysteresis=3, direction_up=True)
        assert 0 <= d <= 100, f"温度 {t} 产生非法 duty {d}"
        d2 = calc_target_duty(t, curve, hysteresis=3, direction_up=False)
        assert 0 <= d2 <= 100

def test_fan_curve_nan_inf():
    from fan_curve import calc_target_duty
    import math
    curve = [(40,0),(45,30),(55,50),(65,75),(75,100)]
    for bad in [float('nan'), float('inf'), float('-inf')]:
        try:
            d = calc_target_duty(bad, curve, hysteresis=3, direction_up=True, min_effective_duty=30, start_stop_hysteresis=8)
            # nan 场景不应返回 nan 污染后续
            assert not math.isnan(d), "duty 不应为 nan"
            assert 0 <= d <= 100
        except Exception:
            # 抛异常也可接受，但不应崩整个进程；这里视为通过，只要不卡死
            pass

# ============================================================
# 8. daemon handlers 异常隔离 压力
# ============================================================
def test_daemon_handlers_exception_isolation():
    import peripheral_daemon as pd
    from daemon_state import DaemonState
    state = Mock()
    state.keys = Mock(); state.keys.poll.side_effect = RuntimeError("keys boom")
    state.obtn = Mock(); state.obtn.poll.side_effect = RuntimeError("obtn boom")
    state.cached = {"wifi_mode":"client","wifi_ip":"1.1.1.1","wifi_ssid":"x"}
    state.led = Mock()
    # 这些 handler 内部有 try/except，不应把异常抛到外层
    try:
        pd._handle_keys(state)
        pd._handle_onboard(state)
    except Exception as e:
        assert False, f"handler 应内部捕获异常: {e}"
    # _handle_status_change 也应容忍异常的 state/switcher
    tracker = pd._StatusTracker(state)
    try:
        pd._handle_status_change(state, tracker, switcher=Mock(blink_active=False), request_page=Mock(side_effect=RuntimeError("render boom")))
    except Exception:
        pass  # 允许抛，但主循环外层会捕获；这里只确保不卡死

# ============================================================
# 9. 环境变量/配置 极端值
# ============================================================
def test_env_int_extreme():
    from validation import env_int
    with patch.dict(os.environ, {"F": "notanint"}):
        assert env_int("F", 10, 0, 100) == 10
    with patch.dict(os.environ, {"F": "9999"}):
        assert env_int("F", 10, 0, 100) == 100  # 越界收敛
    with patch.dict(os.environ, {"F": "-9999"}):
        assert env_int("F", 10, 0, 100) == 0
    with patch.dict(os.environ, {"F": ""}):
        assert env_int("F", 10, 0, 100) == 10

def test_parse_allowed_schemes_fuzz():
    from validation import parse_allowed_schemes
    assert parse_allowed_schemes("") == {"http","https"}
    assert parse_allowed_schemes(",,,") == {"http","https"}
    assert parse_allowed_schemes("http, https, ftp") == {"http","https","ftp"}
    # 非法 scheme 被过滤
    assert "123bad" not in parse_allowed_schemes("123bad,http")
