"""net_switcher.py —— 板载按键网络切换状态机单测。

用 FakeLed 打桩硬件, mock subprocess/local_network_mode 验证状态转移。
"""

import time

import pytest

import net_switcher
from net_switcher import NetworkSwitcher


class FakeLed:
    """最小 LED 桩: 记录 set_* 调用。"""

    def __init__(self):
        self.power = False
        self.hotspot = False
        self.wifi = False
        self.calls = []

    def set_power(self, on):
        self.power = on
        self.calls.append(("power", on))

    def set_hotspot(self, on):
        self.hotspot = on
        self.calls.append(("hotspot", on))

    def set_wifi(self, on):
        self.wifi = on
        self.calls.append(("wifi", on))


# ---- decide_action ----

def test_decide_action():
    assert NetworkSwitcher.decide_action("ap") == "wifi"
    assert NetworkSwitcher.decide_action("client") == "hotspot"
    assert NetworkSwitcher.decide_action("") == "wifi"
    assert NetworkSwitcher.decide_action("unknown") == "wifi"


# ---- on_button 状态机 ----

def test_on_button_long_ignored():
    sw = NetworkSwitcher(FakeLed())
    sw.on_button("ap", "long")
    assert not sw.busy
    assert not sw.switching
    assert not sw.switch_done


def test_on_button_switch_flow(monkeypatch):
    import threading

    # 注意: 不打桩 time.sleep —— 切换流程里有真实的 2s 稳定等待,
    # 测试等待也要用真实 sleep, 否则"等待"瞬间结束导致断言过早 (曾踩坑)。
    gate = threading.Event()   # 闸门: 让后台线程停在"切换中", 便于确定性观察

    def fake_run(cmd, **kwargs):
        gate.wait(timeout=5)
        return type("R", (), {"stdout": "[net] done\n"})()

    monkeypatch.setattr(net_switcher.subprocess, "run", fake_run)
    monkeypatch.setattr(net_switcher, "local_network_mode", lambda: "client")

    led = FakeLed()
    sw = NetworkSwitcher(led)
    sw.on_button("ap", "press")   # ap → 目标 wifi
    assert sw.busy                 # 线程阻塞在 subprocess.run, busy 必然为 True
    assert sw.switching
    assert sw.blink_active
    # 闪烁线程首个周期 ~0.4s 后才点亮目标灯, 等待其发生再断言
    for _ in range(100):
        if any(c[0] in ("hotspot", "wifi") for c in led.calls):
            break
        time.sleep(0.02)
    assert any(c[0] in ("hotspot", "wifi") for c in led.calls)

    gate.set()                     # 放行; 切换流程含 2s 稳定等待
    for _ in range(300):
        if not sw.busy:
            break
        time.sleep(0.02)
    assert not sw.busy
    assert sw.switch_done
    assert not sw.switching
    assert not sw.blink_active


def test_on_button_busy_queues_second_press():
    sw = NetworkSwitcher(FakeLed())
    sw._net_busy = True   # 模拟切换进行中
    sw.on_button("client", "press")
    # 手动按键应排队: 当前动作仍占用 busy, 不应立即起新线程
    assert sw.busy
    assert not sw.switching


def test_on_button_busy_queues_manual_press(monkeypatch):
    sw = NetworkSwitcher(FakeLed())
    sw._net_busy = True
    sw.on_button("client", "press")
    assert sw.busy
    assert sw._pending_button == ("client", "press")

    called = []
    monkeypatch.setattr(sw, "on_button", lambda mode, event: called.append((mode, event)))
    sw._finish_action()
    assert not sw.busy
    assert called == [("client", "press")]


def test_on_button_blink_keeps_old_led(monkeypatch):
    """WiFi→热点: 黄灯闪烁 + 绿灯(老状态)常亮。"""
    import threading

    gate = threading.Event()

    def fake_run(cmd, **kwargs):
        gate.wait(timeout=5)
        return type("R", (), {"stdout": "[net] done\n"})()

    monkeypatch.setattr(net_switcher.subprocess, "run", fake_run)
    monkeypatch.setattr(net_switcher, "local_network_mode", lambda: "ap")

    led = FakeLed()
    sw = NetworkSwitcher(led)
    sw.on_button("client", "press")   # client → 目标 hotspot
    # 等闪烁线程跑完一个完整周期 (黄灯出现 True 和 False)
    for _ in range(200):
        if ("hotspot", False) in led.calls:
            break
        time.sleep(0.02)
    # 老绿灯必须常亮 (出现过 True), 目标黄灯在闪烁
    assert ("wifi", True) in led.calls
    assert ("hotspot", True) in led.calls
    assert ("hotspot", False) in led.calls

    gate.set()
    for _ in range(300):
        if not sw.busy:
            break
        time.sleep(0.02)
    assert not sw.busy


# ---- trigger_recovery_hotspot (独立恢复热点入口) ----

@pytest.mark.parametrize(
    ("enable", "expected_action"),
    [(True, "auto-hotspot"), (False, "auto-hotspot-stop")],
)
def test_trigger_recovery_hotspot_flow(monkeypatch, enable, expected_action):
    import threading

    captured = {}
    gate = threading.Event()

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        gate.wait(timeout=5)
        return type(
            "R", (), {"stdout": "[net] done\n", "stderr": "", "returncode": 0},
        )()

    monkeypatch.setattr(net_switcher.subprocess, "run", fake_run)
    monkeypatch.setattr(net_switcher, "is_ap_interface", lambda _iface: enable)

    sw = NetworkSwitcher(FakeLed())
    assert sw.trigger_recovery_hotspot(enable) is True
    assert sw.busy
    assert sw.switching
    assert sw.blink_active

    gate.set()
    for _ in range(300):
        if not sw.busy:
            break
        time.sleep(0.02)
    assert captured["cmd"][-1] == expected_action
    assert not sw.busy
    assert sw.switch_done
    assert not sw.switching


def test_trigger_recovery_hotspot_busy_returns_false():
    sw = NetworkSwitcher(FakeLed())
    sw._net_busy = True
    assert sw.trigger_recovery_hotspot(True) is False
    assert not sw.switching


# ---- LED 闪烁: 老状态灯常亮 ----

def test_blink_keeps_old_led_lit():
    led = FakeLed()
    sw = NetworkSwitcher(led)
    sw._start_blink("wifi", keep="hotspot")   # 目标绿灯闪烁, 老黄灯常亮
    # 闪烁周期 0.4s, 等第二个周期出现绿灯灭 (False) 才算完整闪了一轮
    for _ in range(200):
        if ("wifi", False) in led.calls:
            break
        time.sleep(0.02)
    # 老黄灯必须常亮 (出现过 True), 绿灯在闪烁 (出现过 True 和 False)
    assert ("hotspot", True) in led.calls
    assert ("wifi", True) in led.calls
    assert ("wifi", False) in led.calls
    sw._stop_blink()


def test_blink_no_keep_when_unknown_old_state():
    led = FakeLed()
    sw = NetworkSwitcher(led)
    sw._start_blink("hotspot", keep=None)   # 断网/未知: 无老灯
    for _ in range(100):
        if any(c[0] in ("hotspot", "wifi") for c in led.calls):
            break
        time.sleep(0.02)
    # 老 wifi 灯不应被点亮
    assert ("wifi", True) not in led.calls
    sw._stop_blink()


def test_network_switch_failure_logs_but_completes(monkeypatch, caplog):
    monkeypatch.setattr(
        net_switcher.subprocess, "run",
        lambda *a, **k: type("R", (), {"stdout": ""})(),
    )
    monkeypatch.setattr(net_switcher, "local_network_mode", lambda: "")   # 未达预期

    sw = NetworkSwitcher(FakeLed())
    sw.on_button("client", "press")   # client → 目标 hotspot
    # 切换流程含 2s 稳定等待, 放宽轮询窗口
    for _ in range(300):
        if not sw.busy:
            break
        time.sleep(0.02)
    assert sw.switch_done
    assert "未达预期" in caplog.text


# ---- reset_after_switch / cleanup ----

def test_reset_after_switch_consumes_flag():
    sw = NetworkSwitcher(FakeLed())
    sw._switch_done = True
    assert sw.reset_after_switch() is True
    assert sw.reset_after_switch() is False


def test_cleanup_stops_blink_and_resets():
    led = FakeLed()
    sw = NetworkSwitcher(led)
    sw._start_blink("hotspot")
    sw._switch_done = True
    sw._switching = True
    sw.cleanup()
    assert not sw.blink_active
    assert not sw.switch_done
    assert not sw.switching
