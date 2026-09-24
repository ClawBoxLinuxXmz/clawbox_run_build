"""net_auto_recover.py —— 独立临时热点恢复状态机单测。"""

import time

import net_auto_recover
from net_auto_recover import NetworkAutoRecover


class FakeSwitcher:
    def __init__(self):
        self.actions = []
        self.busy = False
        self.accept = True

    def trigger_recovery_hotspot(self, enable):
        self.actions.append(enable)
        return self.accept


def make_recover(grace_s=5.0, stable_s=0.0, client_grace_s=10.0,
                 poll_s=0.005):
    return NetworkAutoRecover(
        FakeSwitcher(), grace_s=grace_s, client_stable_s=stable_s,
        ap_client_grace_s=client_grace_s, poll_s=poll_s,
        recovery_iface="wlan0ap",
    )


def wait_until(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.005)
    assert predicate()


def stop_recover(rec):
    rec.cancel()
    wait_until(lambda: not rec.recovering)


def test_check_connected_or_manual_ap_does_not_recover():
    rec = make_recover()
    rec.check(True, False, 0.0)
    rec.check(False, True, 10.0)
    assert not rec.recovering
    assert rec._switcher.actions == []


def test_check_lost_within_grace_does_not_recover():
    rec = make_recover(grace_s=5.0)
    rec.check(False, False, 0.0)
    rec.check(False, False, 4.9)
    assert not rec.recovering


def test_check_lost_beyond_grace_starts_recovery(monkeypatch):
    monkeypatch.setattr(net_auto_recover, "is_ap_interface", lambda _iface: True)
    monkeypatch.setattr(net_auto_recover, "is_wifi_client_connected", lambda: False)
    rec = make_recover(grace_s=1.0)
    rec.check(False, False, 0.0)
    rec.check(False, False, 2.0)
    wait_until(lambda: rec._switcher.actions == [True])
    assert rec.recovering
    stop_recover(rec)


def test_busy_restarts_full_grace_timer():
    rec = make_recover(grace_s=2.0)
    rec._switcher.busy = True
    rec.check(False, False, 0.0)
    rec.check(False, False, 3.0)
    rec._switcher.busy = False
    rec.check(False, False, 4.0)
    assert not rec.recovering


def test_recovery_keeps_ap_while_nm_reconnects_then_stops(monkeypatch):
    rec = make_recover(stable_s=0.0)
    monkeypatch.setattr(
        net_auto_recover, "is_ap_interface",
        lambda _iface: bool(rec._switcher.actions and rec._switcher.actions[-1]),
    )
    monkeypatch.setattr(net_auto_recover, "is_wifi_client_connected", lambda: True)
    monkeypatch.setattr(net_auto_recover, "count_ap_clients", lambda _iface: 0)

    rec._start_recovery()
    wait_until(lambda: not rec.recovering)
    assert rec._switcher.actions == [True, False]


def test_connected_ap_client_defers_stop_until_client_leaves(monkeypatch):
    rec = make_recover(stable_s=0.0, client_grace_s=10.0)
    counts = iter([1, 0])
    seen = []
    monkeypatch.setattr(
        net_auto_recover, "is_ap_interface",
        lambda _iface: bool(rec._switcher.actions and rec._switcher.actions[-1]),
    )
    monkeypatch.setattr(net_auto_recover, "is_wifi_client_connected", lambda: True)

    def fake_count(_iface):
        value = next(counts)
        seen.append(value)
        return value

    monkeypatch.setattr(net_auto_recover, "count_ap_clients", fake_count)
    rec._start_recovery()
    wait_until(lambda: not rec.recovering)
    assert seen == [1, 0]
    assert rec._switcher.actions == [True, False]


def test_cancel_leaves_current_network_for_manual_action(monkeypatch):
    rec = make_recover()
    monkeypatch.setattr(net_auto_recover, "is_ap_interface", lambda _iface: True)
    monkeypatch.setattr(net_auto_recover, "is_wifi_client_connected", lambda: False)
    rec._start_recovery()
    wait_until(lambda: rec._switcher.actions == [True])
    stop_recover(rec)
    assert rec._switcher.actions == [True]


def test_manual_ap_cancels_active_recovery(monkeypatch):
    rec = make_recover()
    monkeypatch.setattr(net_auto_recover, "is_ap_interface", lambda _iface: True)
    monkeypatch.setattr(net_auto_recover, "is_wifi_client_connected", lambda: False)
    rec._start_recovery()
    wait_until(lambda: rec._switcher.actions == [True])
    rec.check(False, True, 20.0)
    wait_until(lambda: not rec.recovering)


def test_recovery_aborts_if_switcher_is_busy():
    rec = make_recover()
    rec._switcher.accept = False
    rec._start_recovery()
    wait_until(lambda: not rec.recovering)
    assert rec._switcher.actions == [True]


def test_reset_clears_loss_and_cancels(monkeypatch):
    rec = make_recover()
    monkeypatch.setattr(net_auto_recover, "is_ap_interface", lambda _iface: True)
    monkeypatch.setattr(net_auto_recover, "is_wifi_client_connected", lambda: False)
    rec.check(False, False, 0.0)
    rec._start_recovery()
    wait_until(lambda: rec.recovering)
    rec.reset()
    assert rec._lost_since is None
    wait_until(lambda: not rec.recovering)
