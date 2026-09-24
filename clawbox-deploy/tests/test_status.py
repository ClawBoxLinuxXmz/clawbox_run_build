"""status.py —— 状态更新单测。

重点覆盖 2026-08-17 实机发现的 bug: API 返回 null 字段时,
dict.get(key, default) 的默认值只在键不存在时生效, 键存在但值为 null
会返回 None; None != "" 恒为 True, 会让主循环误判 SSID 变化并频繁重绘
(实机日志: WiFi 断开时 'SSID 变化: 无 → 无' 连续触发 ver=2..16)。
"""

import status
from daemon_state import DaemonState


class FakeApi:
    """最小 API 桩: 按需返回 setup/wifi/system 响应。"""

    def __init__(self, setup=None, wifi=None, sys_info=None):
        self._setup = setup or {}
        self._wifi = wifi or {}
        self._sys_info = sys_info or {}

    def get_setup_status(self, timeout=None):
        return self._setup

    def get_wifi_status(self, timeout=None):
        return self._wifi

    def get_system_info(self, timeout=None):
        return self._sys_info


def _patch_local(monkeypatch, mode="client", ip="192.168.1.137", hostname="clawbox"):
    """打桩本地探测, 避免真实子进程调用。"""
    monkeypatch.setattr(status, "local_network_mode", lambda: mode)
    monkeypatch.setattr(status, "get_local_ip", lambda *a, **k: ip)
    monkeypatch.setattr(status, "get_local_hostname", lambda: hostname)


# ---- API 返回 null 字段 → cached 必须归一化为 "" (而非 None) ----

def test_ssid_null_normalized_to_empty(monkeypatch):
    """API 返回 ssid=null 时, cached 里应存 "" 而非 None。"""
    state = DaemonState()
    state.api = FakeApi(
        setup={"wifi_mode": "client", "wifi_ssid": None},
        wifi={"mode": "client", "ssid": None, "ipv4": "192.168.1.137"},
    )
    _patch_local(monkeypatch)

    status.update_status_from_api(state)

    assert state.cached["wifi_ssid"] == ""
    assert state.cached["wifi_ssid"] is not None


def test_ssid_empty_normalized_to_empty(monkeypatch):
    """API 返回 ssid="" 时, cached 里应存 "" 而非 None。"""
    state = DaemonState()
    state.api = FakeApi(
        setup={"wifi_mode": "client", "wifi_ssid": ""},
        wifi={"mode": "client", "ssid": "", "ipv4": "192.168.1.137"},
    )
    _patch_local(monkeypatch)

    status.update_status_from_api(state)

    assert state.cached["wifi_ssid"] == ""


def test_ssid_normal_string_preserved(monkeypatch):
    """API 返回正常 SSID 时, cached 里应存原值。"""
    state = DaemonState()
    state.api = FakeApi(
        setup={"wifi_mode": "client", "wifi_ssid": "HomeSSID"},
        wifi={"mode": "client", "ssid": "HomeSSID", "ipv4": "192.168.1.137"},
    )
    _patch_local(monkeypatch)

    status.update_status_from_api(state)

    assert state.cached["wifi_ssid"] == "HomeSSID"


def test_mode_null_normalized_when_local_unknown(monkeypatch):
    """API 返回 mode=null 且本地探测未知时, cached 里应存 "" 而非 None。"""
    state = DaemonState()
    state.api = FakeApi(
        setup={"wifi_mode": None, "wifi_ssid": None},
        wifi={"mode": None, "ssid": None, "ipv4": "192.168.1.137"},
    )
    _patch_local(monkeypatch, mode="")

    status.update_status_from_api(state)

    assert state.cached["wifi_mode"] == ""
    assert state.cached["wifi_mode"] is not None


def test_hostname_null_normalized(monkeypatch):
    """API 返回 hostname=null 且本地探测也为空时, cached 里应存 "" 而非 None。"""
    state = DaemonState()
    state.api = FakeApi(
        setup={"wifi_mode": "client", "wifi_ssid": "HomeSSID"},
        wifi={"mode": "client", "ssid": "HomeSSID", "ipv4": "192.168.1.137"},
        sys_info={"hostname": None, "accessUrl": "http://clawbox.local/"},
    )
    _patch_local(monkeypatch, hostname="")

    status.update_status_from_api(state)

    assert state.cached["hostname"] == ""
    assert state.cached["hostname"] is not None


# ---- 本地兜底路径 (API 不可达) ----

def test_api_error_falls_back_to_local(monkeypatch):
    """API 返回 _error 时, 用本地探测结果填充, 且不存 None。"""
    state = DaemonState()
    state.api = FakeApi(setup={"_error": "connection refused"})
    monkeypatch.setattr(status, "detect_wifi_mode", lambda: "ap")
    monkeypatch.setattr(status, "get_local_wifi_ssid", lambda: "")
    _patch_local(monkeypatch, mode="ap", ip="192.168.4.1")

    status.update_status_from_api(state)

    assert state.cached["wifi_mode"] == "ap"
    assert state.cached["wifi_ssid"] == ""
    assert state.cached["wifi_ip"] == "192.168.4.1"