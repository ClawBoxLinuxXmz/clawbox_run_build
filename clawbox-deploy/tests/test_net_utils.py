"""net_utils.py —— 本地网络探测单测 (mock subprocess/ioctl 输出)。"""

import builtins

import net_utils


class _R:
    """模拟 subprocess.CompletedProcess (只暴露测试关心的 stdout)。"""

    def __init__(self, stdout=""):
        self.stdout = stdout


# ---- decode_iw_ssid ----

def test_decode_iw_ssid_plain_ascii():
    assert net_utils.decode_iw_ssid("ClawBox-WiFi") == "ClawBox-WiFi"


def test_decode_iw_ssid_escaped_utf8():
    # "测试" 的 UTF-8 字节 = \xe6\xb5\x8b\xe8\xaf\x95
    raw = "\\xe6\\xb5\\x8b\\xe8\\xaf\\x95"
    assert net_utils.decode_iw_ssid(raw) == "测试"


def test_decode_iw_ssid_invalid_falls_back():
    assert net_utils.decode_iw_ssid("\\xff\\xff") == "\\xff\\xff"


# ---- get_local_ip ----

def test_get_local_ip_uses_hostname_fallback(monkeypatch):
    """接口查询无结果时接受合法的 172.x WiFi 地址。"""
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "fcntl":
            raise ImportError("fcntl unavailable")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    def fake_run(cmd, **kwargs):
        if cmd[0] == net_utils.CMD_IP:
            return _R("")
        assert cmd == [net_utils.CMD_HOSTNAME, "-I"]
        return _R("127.0.0.1 172.20.4.9 192.168.1.5\n")

    monkeypatch.setattr(net_utils.subprocess, "run", fake_run)
    assert net_utils.get_local_ip() == "172.20.4.9"


def test_get_local_ip_queries_requested_interface_before_hostname(monkeypatch):
    """接口级查询避免把容器网卡地址误当成无线网地址。"""
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "fcntl":
            raise ImportError("fcntl unavailable")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    def fake_run(cmd, **kwargs):
        assert cmd == [
            net_utils.CMD_IP, "-4", "-o", "addr", "show", "dev", "wlan0ap",
            "scope", "global",
        ]
        return _R("7: wlan0ap inet 10.42.0.1/24 brd 10.42.0.255 scope global wlan0ap\n")

    monkeypatch.setattr(net_utils.subprocess, "run", fake_run)
    assert net_utils.get_local_ip("wlan0ap") == "10.42.0.1"


def test_get_local_hostname_returns_string():
    assert isinstance(net_utils.get_local_hostname(), str)
    assert net_utils.get_local_hostname() != ""


def test_run_stdout_treats_nonzero_exit_as_probe_failure(monkeypatch):
    class Result:
        returncode = 1
        stdout = "stale output"

    monkeypatch.setattr(net_utils.subprocess, "run", lambda *a, **k: Result())
    assert net_utils._run_stdout(["iw", "dev"], timeout=1) == ""


# ---- detect_wifi_mode ----

def test_detect_wifi_mode_ap(monkeypatch):
    def fake_run(cmd, **kwargs):
        if "hostapd" in cmd:
            return _R("active\n")
        return _R("")

    monkeypatch.setattr(net_utils.subprocess, "run", fake_run)
    assert net_utils.detect_wifi_mode() == "ap"


def test_detect_wifi_mode_client(monkeypatch):
    def fake_run(cmd, **kwargs):
        if "hostapd" in cmd:
            return _R("inactive\n")
        return _R("Connected to ClawBox (on wlan0)\n\tSSID: ClawBox\n")

    monkeypatch.setattr(net_utils.subprocess, "run", fake_run)
    assert net_utils.detect_wifi_mode() == "client"


def test_detect_wifi_mode_unknown(monkeypatch):
    def fake_run(cmd, **kwargs):
        if "hostapd" in cmd:
            return _R("inactive\n")
        return _R("Not connected.\n")

    monkeypatch.setattr(net_utils.subprocess, "run", fake_run)
    assert net_utils.detect_wifi_mode() == ""


# ---- local_network_mode ----

def test_local_network_mode_ap(monkeypatch):
    def fake_run(cmd, **kwargs):
        if "info" in cmd:
            return _R("Interface wlan0\n\ttype AP\n")
        return _R("")

    monkeypatch.setattr(net_utils.subprocess, "run", fake_run)
    assert net_utils.local_network_mode() == "ap"


def test_local_network_mode_client(monkeypatch):
    def fake_run(cmd, **kwargs):
        if "info" in cmd:
            return _R("Interface wlan0\n\ttype managed\n")
        return _R("Connected to X (on wlan0)\n")

    monkeypatch.setattr(net_utils.subprocess, "run", fake_run)
    assert net_utils.local_network_mode() == "client"


def test_local_network_mode_unknown(monkeypatch):
    def fake_run(cmd, **kwargs):
        if "info" in cmd:
            return _R("Interface wlan0\n\ttype managed\n")
        return _R("Not connected.\n")

    monkeypatch.setattr(net_utils.subprocess, "run", fake_run)
    assert net_utils.local_network_mode() == ""


def test_local_network_mode_recognizes_recovery_ap(monkeypatch):
    def fake_run(cmd, **kwargs):
        if cmd[-1] == "link":
            return _R("Not connected.\n")
        if net_utils.RECOVERY_AP_IFACE in cmd:
            return _R("Interface wlan0ap\n\ttype AP\n")
        return _R("Interface wlan0\n\ttype managed\n")

    monkeypatch.setattr(net_utils.subprocess, "run", fake_run)
    assert net_utils.local_network_mode() == "ap"


def test_local_network_mode_prefers_connected_client_over_recovery_ap(monkeypatch):
    def fake_run(cmd, **kwargs):
        if cmd[-1] == "link":
            return _R("Connected to X (on wlan0)\n")
        if net_utils.RECOVERY_AP_IFACE in cmd:
            return _R("Interface wlan0ap\n\ttype AP\n")
        return _R("Interface wlan0\n\ttype managed\n")

    monkeypatch.setattr(net_utils.subprocess, "run", fake_run)
    assert net_utils.local_network_mode() == "client"


def test_count_ap_clients(monkeypatch):
    monkeypatch.setattr(
        net_utils.subprocess, "run",
        lambda *a, **k: _R(
            "Station aa:bb:cc:dd:ee:01 (on wlan0ap)\n"
            "\tsignal: -40 dBm\n"
            "Station aa:bb:cc:dd:ee:02 (on wlan0ap)\n"
        ),
    )
    assert net_utils.count_ap_clients("wlan0ap") == 2


# ---- get_local_wifi_ssid ----

def test_get_local_wifi_ssid_decodes(monkeypatch):
    def fake_run(cmd, **kwargs):
        return _R("        SSID: \\xe6\\xb5\\x8b\\xe8\\xaf\\x95\n")

    monkeypatch.setattr(net_utils.subprocess, "run", fake_run)
    assert net_utils.get_local_wifi_ssid() == "测试"


def test_get_local_wifi_ssid_empty_when_no_ssid(monkeypatch):
    def fake_run(cmd, **kwargs):
        return _R("Not connected.\n")

    monkeypatch.setattr(net_utils.subprocess, "run", fake_run)
    assert net_utils.get_local_wifi_ssid() == ""
