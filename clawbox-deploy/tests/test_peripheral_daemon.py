"""peripheral_daemon.py 主循环 handler 单测 (问题3, 2026-08-18)。

每个 handler 用桩对象隔离测试, 不触发真实硬件/网络/后台线程。
行为必须与重构前内联主循环一致 (不损坏已有功能)。
"""

import types

import peripheral_daemon as pd


class _Cached:
    """模拟 DaemonState.cached (dict 风格访问)。"""

    def __init__(self, **kw):
        self.data = dict(kw)

    def get(self, key, default=None):
        return self.data.get(key, default)

    def __getitem__(self, key):
        return self.data[key]

    def __setitem__(self, key, value):
        self.data[key] = value


class _State:
    def __init__(self, **cached):
        self.cached = _Cached(**cached)
        self.current_page = 0
        self.keys = None
        self.obtn = None
        self.led = None


class _Tracker:
    def __init__(self, mode="", ip="", ssid=""):
        self.mode = mode
        self.ip = ip
        self.ssid = ssid


def _noop_gen(p):
    raise AssertionError("request_page 不应被调用")


# ---- _StatusTracker ----

def test_status_tracker_reads_initial_cache():
    st = _State(wifi_mode="ap", wifi_ip="192.168.1.5", wifi_ssid="ClawBox")
    t = pd._StatusTracker(st)
    assert t.mode == "ap"
    assert t.ip == "192.168.1.5"
    assert t.ssid == "ClawBox"


def test_status_tracker_defaults_empty():
    st = _State()
    t = pd._StatusTracker(st)
    assert t.mode == ""
    assert t.ip == ""
    assert t.ssid == ""


# ---- _handle_keys ----

def test_handle_keys_polls_when_present():
    st = _State()
    polled = []
    st.keys = types.SimpleNamespace(poll=lambda: polled.append(1))
    pd._handle_keys(st)
    assert polled == [1]


def test_handle_keys_skips_when_absent():
    pd._handle_keys(_State())  # keys=None, 不应抛


def test_handle_keys_swallows_exception():
    st = _State()

    def boom():
        raise RuntimeError("key fail")

    st.keys = types.SimpleNamespace(poll=boom)
    pd._handle_keys(st)  # 异常被 handler 内部捕获, 不向上抛


# ---- _handle_onboard ----

def test_handle_onboard_polls_when_present():
    st = _State()
    polled = []
    st.obtn = types.SimpleNamespace(poll=lambda: polled.append(1))
    pd._handle_onboard(st)
    assert polled == [1]


def test_handle_onboard_skips_when_absent():
    pd._handle_onboard(_State())  # obtn=None, 不应抛


def test_handle_onboard_swallows_exception():
    st = _State()

    def boom():
        raise RuntimeError("obtn fail")

    st.obtn = types.SimpleNamespace(poll=boom)
    pd._handle_onboard(st)  # 不应抛


# ---- _handle_net_recover ----

def test_handle_net_recover_calls_check_when_due(monkeypatch):
    calls = []
    recover = types.SimpleNamespace(check=lambda *a: calls.append(a))
    monkeypatch.setattr(pd, "is_wifi_client_connected", lambda: True)
    monkeypatch.setattr(pd.os.path, "exists", lambda p: False)
    monkeypatch.setattr(pd.time, "monotonic", lambda: 123.0)
    result = pd._handle_net_recover(recover, 0.0, 1000.0)
    assert result == 1000.0  # 成功后记录本次 loop_start
    assert len(calls) == 1
    assert calls[0][0] is True      # is_wifi_client_connected()
    assert calls[0][1] is False     # os.path.exists(FORCE_AP_FLAG)
    assert calls[0][2] == 123.0     # time.monotonic()


def test_handle_net_recover_skips_before_interval():
    recover = types.SimpleNamespace(
        check=lambda *a: (_ for _ in ()).throw(AssertionError("不应被调用")),
    )
    last = 100.0
    loop_start = 100.0 + pd.NET_RECOVER_CHECK_INTERVAL - 0.001
    result = pd._handle_net_recover(recover, last, loop_start)
    assert result == last


def test_handle_net_recover_swallows_exception():
    def boom(*a):
        raise RuntimeError("recover fail")

    recover = types.SimpleNamespace(check=boom)
    last = 0.0
    result = pd._handle_net_recover(recover, last, 1000.0)
    assert result == last  # 异常时保持上次检查时间, 下轮继续


# ---- _handle_status_change ----

def test_handle_status_change_no_change_no_redraw():
    st = _State(wifi_mode="ap", wifi_ip="1.1.1.1", wifi_ssid="X")
    t = _Tracker(mode="ap", ip="1.1.1.1", ssid="X")
    switcher = types.SimpleNamespace(switching=False, switch_done=False)
    pd._handle_status_change(st, t, switcher, _noop_gen)
    assert (t.mode, t.ip, t.ssid) == ("ap", "1.1.1.1", "X")


def test_handle_status_change_detects_and_redraws():
    st = _State(wifi_mode="client", wifi_ip="2.2.2.2", wifi_ssid="Y")
    t = _Tracker(mode="ap", ip="1.1.1.1", ssid="X")
    switcher = types.SimpleNamespace(switching=False, switch_done=False)
    called = []
    st.current_page = 1
    pd._handle_status_change(st, t, switcher, lambda p: called.append(p))
    assert called == [1]
    assert (t.mode, t.ip, t.ssid) == ("client", "2.2.2.2", "Y")


def test_handle_status_change_suppressed_during_switch():
    st = _State(wifi_mode="ap", wifi_ip="1.1.1.1", wifi_ssid="")
    t = _Tracker(mode="client", ip="9.9.9.9", ssid="W")
    switcher = types.SimpleNamespace(switching=True, switch_done=False)
    st.current_page = 3
    pd._handle_status_change(st, t, switcher, _noop_gen)
    # 切换期间不重绘, 但 tracker 仍更新 (与内联版行为一致)
    assert t.mode == "ap"


def test_handle_status_change_null_normalized():
    """cached 里存 None 时按 "" 归一化, 不误判变化 (2026-08-17 实机)。"""
    st = _State()
    st.cached["wifi_mode"] = None
    st.cached["wifi_ip"] = None
    st.cached["wifi_ssid"] = None
    t = _Tracker(mode="", ip="", ssid="")
    switcher = types.SimpleNamespace(switching=False, switch_done=False)
    pd._handle_status_change(st, t, switcher, _noop_gen)
    assert (t.mode, t.ip, t.ssid) == ("", "", "")


# ---- _handle_leds ----

def test_handle_leds_skips_without_led(monkeypatch):
    st = _State()
    pd._handle_leds(st, None)  # led=None, 不应调 _update_leds


def test_handle_leds_calls_update(monkeypatch):
    st = _State()
    st.led = object()
    updated = []
    switcher = type("Switcher", (), {"blink_active": False})()
    pd._handle_leds(st, switcher, lambda state, actual_switcher: updated.append((state, actual_switcher)))
    assert updated == [(st, switcher)]


# ---- _handle_qr_trigger ----

def test_handle_qr_trigger_new_qr(monkeypatch):
    st = _State(chat_qr_url="old", chat_qr_platform="wechat")
    st.current_page = 0
    watcher = types.SimpleNamespace(check_qr=lambda: {
        "qr_url": "new-url", "platform": "whatsapp", "qr_type": "image",
    })
    called = []
    monkeypatch.setattr(pd.time, "time", lambda: 999.0)
    pd._handle_qr_trigger(st, watcher, lambda p: called.append(p))
    assert st.cached["chat_qr_url"] == "new-url"
    assert st.cached["chat_qr_platform"] == "whatsapp"
    assert st.cached["chat_qr_type"] == "image"
    assert st.cached["chat_qr_updated_at"] == 999.0
    assert st.current_page == 2
    assert called == [2]


def test_handle_qr_trigger_same_url_noop():
    st = _State(chat_qr_url="same")
    st.current_page = 1
    watcher = types.SimpleNamespace(check_qr=lambda: {
        "qr_url": "same", "platform": "x", "qr_type": "y",
    })
    called = []
    pd._handle_qr_trigger(st, watcher, lambda p: called.append(p))
    assert called == []
    assert st.current_page == 1


def test_handle_qr_trigger_swallows_exception():
    st = _State(chat_qr_url="old")

    def boom():
        raise RuntimeError("qr fail")

    watcher = types.SimpleNamespace(check_qr=boom)
    pd._handle_qr_trigger(st, watcher, _noop_gen)  # 不应抛


# ---- _handle_locale_trigger ----

def test_handle_locale_trigger_changes_locale(monkeypatch):
    st = _State(locale="zh-CN")
    st.current_page = 1
    watcher = types.SimpleNamespace(check_locale=lambda: "en")
    monkeypatch.setattr(pd, "resolve_screen_locale", lambda raw: "en")
    monkeypatch.setattr(pd, "set_locale", lambda loc: None)
    called = []
    pd._handle_locale_trigger(st, watcher, lambda p: called.append(p))
    assert st.cached["locale"] == "en"
    assert called == [1]


def test_handle_locale_trigger_same_locale_noop(monkeypatch):
    st = _State(locale="zh-CN")
    watcher = types.SimpleNamespace(check_locale=lambda: "zh-CN")
    monkeypatch.setattr(pd, "resolve_screen_locale", lambda raw: "zh-CN")
    called = []
    pd._handle_locale_trigger(st, watcher, lambda p: called.append(p))
    assert called == []


# ---- _handle_qr_expiry ----

def test_handle_qr_expiry_whatsapp_expired(monkeypatch):
    st = _State(chat_qr_type="image", chat_qr_platform="whatsapp",
                chat_qr_updated_at=100.0)
    st.current_page = 2
    monkeypatch.setattr(pd.time, "time", lambda: 1000.0)  # 差 900s > 60s
    called = []
    pd._handle_qr_expiry(st, lambda p: called.append(p))
    assert st.current_page == pd.PAGE_QR_EXPIRED
    assert called == [pd.PAGE_QR_EXPIRED]


def test_handle_qr_expiry_never_set_noop(monkeypatch):
    """chat_qr_updated_at=0.0 (从未记录) 时不切换: 原逻辑 qr_ts and ... 短路。"""
    st = _State(chat_qr_type="image", chat_qr_platform="whatsapp",
                chat_qr_updated_at=0.0)
    st.current_page = 2
    monkeypatch.setattr(pd.time, "time", lambda: 1000.0)
    called = []
    pd._handle_qr_expiry(st, lambda p: called.append(p))
    assert called == []
    assert st.current_page == 2


def test_handle_qr_expiry_fresh_not_expired(monkeypatch):
    st = _State(chat_qr_type="image", chat_qr_platform="whatsapp",
                chat_qr_updated_at=1000.0)
    st.current_page = 2
    monkeypatch.setattr(pd.time, "time", lambda: 1001.0)  # 仅 1s, 未过期
    called = []
    pd._handle_qr_expiry(st, lambda p: called.append(p))
    assert called == []
    assert st.current_page == 2


def test_handle_qr_expiry_not_whatsapp_noop(monkeypatch):
    st = _State(chat_qr_type="image", chat_qr_platform="wechat",
                chat_qr_updated_at=0.0)
    st.current_page = 2
    monkeypatch.setattr(pd.time, "time", lambda: 1000.0)
    called = []
    pd._handle_qr_expiry(st, lambda p: called.append(p))
    assert called == []
    assert st.current_page == 2


# ---- _handle_switch_done ----

def test_handle_switch_done_triggers_page3():
    st = _State()
    switcher = types.SimpleNamespace(reset_after_switch=lambda: True)
    called = []
    pd._handle_switch_done(st, switcher, lambda p: called.append(p))
    assert st.current_page == 3
    assert called == [3]


def test_handle_switch_done_no_switch_noop():
    st = _State()
    switcher = types.SimpleNamespace(reset_after_switch=lambda: False)
    called = []
    pd._handle_switch_done(st, switcher, lambda p: called.append(p))
    assert called == []
    assert st.current_page == 0


def test_handle_switch_done_swallows_exception():
    st = _State()

    def boom():
        raise RuntimeError("switch fail")

    switcher = types.SimpleNamespace(reset_after_switch=boom)
    pd._handle_switch_done(st, switcher, _noop_gen)  # 不应抛


def test_init_fan_degrades_when_module_missing(monkeypatch):
    st = _State()
    monkeypatch.setattr(pd, "FanController", None)
    pd._init_fan(st)
    assert st.fan is None


def test_run_boot_to_idle_degrades_without_screen_worker(monkeypatch):
    ctx = types.SimpleNamespace(
        state=types.SimpleNamespace(led=None, current_page=1, cached={}),
        screen_worker=None,
        switcher=None,
        watcher=None,
    )
    monkeypatch.setattr(pd.time, "sleep", lambda _seconds: None)
    pd._run_boot_to_idle(ctx)
    assert ctx.state.current_page == 0
