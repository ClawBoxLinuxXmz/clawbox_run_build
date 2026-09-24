"""network_action.sh 辅助函数契约测试 (2026-08-14 审查 P1-3)。

通过 source 导入脚本函数, 用 bash 函数 mock nmcli/iw/ip/rfkill,
不依赖真实网络环境。脚本末尾的 case 只在直接执行时运行 (同日加的守卫),
source 后仅定义函数。
"""

import os
from pathlib import Path
import shutil
import subprocess

import pytest

PERIPHERAL_DIR = Path(__file__).resolve().parents[1] / "clawbox-peripheral"
NET_ACTION = PERIPHERAL_DIR / "network_action.sh"

# bash 函数 mock: 从 FAKE_NET_DIR 目录读取夹具文件
_MOCKS = r'''
iw() {
  if [ "${1:-}" = "dev" ] && [ -z "${2:-}" ]; then
    [ -f "$FAKE_NET_DIR/iw.list" ] && cat "$FAKE_NET_DIR/iw.list"
    return 0
  fi
  if [ "${1:-}" = "dev" ] && [ "${3:-}" = "info" ]; then
    if [ -f "$FAKE_NET_DIR/$2.info" ]; then cat "$FAKE_NET_DIR/$2.info"; return 0; fi
    return 1
  fi
  return 0
}
nmcli() {
  if [ "${1:-}" = "--wait" ] && [ "${2:-}" = "0" ] \
      && [ "${3:-}" = "device" ] && [ "${4:-}" = "connect" ]; then
    echo "$*" >> "$FAKE_NET_DIR/connect-calls"
    [ ! -f "$FAKE_NET_DIR/connect.fail" ]
    return
  fi
  if [ "${1:-}" = "-t" ] && [ "${2:-}" = "-f" ] && [ "${4:-}" = "device" ] && [ "${5:-}" = "show" ]; then
    if [ -f "$FAKE_NET_DIR/nm-${6}-${3}" ]; then cat "$FAKE_NET_DIR/nm-${6}-${3}"; return 0; fi
    return 1
  fi
  if [ "${1:-}" = "-t" ] && [ "${2:-}" = "-f" ] && [ "${4:-}" = "device" ] && [ "${5:-}" = "status" ]; then
    [ -f "$FAKE_NET_DIR/nm.status" ] && cat "$FAKE_NET_DIR/nm.status"
    return 0
  fi
  if [ "${1:-}" = "-g" ]; then
    if [ -f "$FAKE_NET_DIR/nm-${5}-${2}" ]; then cat "$FAKE_NET_DIR/nm-${5}-${2}"; return 0; fi
    return 1
  fi
  return 0
}
ip() { return 0; }
rfkill() { return 0; }
'''


def _run(tmp_path: Path, body: str, extra_env=None) -> subprocess.CompletedProcess:
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is required for shell tests")
    fake_dir = tmp_path / "net"
    fake_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["FAKE_NET_DIR"] = str(fake_dir)
    if extra_env:
        env.update(extra_env)
    script = (
        "set -euo pipefail\n"
        f"{_MOCKS}\n"
        f'. "{NET_ACTION}"\n'
        f"{body}\n"
    )
    return subprocess.run(
        [bash, "-c", script], capture_output=True, text=True,
        encoding="utf-8", env=env,
    )


def _assert_ok(result: subprocess.CompletedProcess) -> None:
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "OK"


def _write(tmp_path: Path, name: str, content: str) -> None:
    d = tmp_path / "net"
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text(content, encoding="utf-8")


def test_iface_exists(tmp_path: Path) -> None:
    _write(tmp_path, "wlan0.info", "Interface wlan0\n")
    result = _run(
        tmp_path,
        'iface_exists wlan0 && echo OK || echo FAIL\n'
        'iface_exists wlan0ap && echo BAD || echo OK\n',
    )
    assert result.stdout.splitlines() == ["OK", "OK"]


def test_is_ap_mode(tmp_path: Path) -> None:
    _write(tmp_path, "wlan0.info", "\ttype AP\n")
    _write(tmp_path, "wlan1.info", "\ttype managed\n")
    result = _run(
        tmp_path,
        'is_ap_mode wlan0 && echo OK || echo FAIL\n'
        'is_ap_mode wlan1 && echo BAD || echo OK\n',
    )
    assert result.stdout.splitlines() == ["OK", "OK"]


def test_is_client_connected(tmp_path: Path) -> None:
    _write(tmp_path, "wlan0.info", "\ttype managed\n")
    _write(tmp_path, "nm-wlan0-GENERAL.STATE", "100\n")
    result = _run(
        tmp_path,
        'is_client_connected wlan0 && echo OK || echo FAIL\n',
    )
    _assert_ok(result)

    _write(tmp_path, "nm-wlan0-GENERAL.STATE", "30\n")
    result = _run(
        tmp_path,
        'is_client_connected wlan0 && echo BAD || echo OK\n',
    )
    _assert_ok(result)


def test_resolve_client_iface_prefers_env(tmp_path: Path) -> None:
    _write(tmp_path, "nm-wlan0-GENERAL.TYPE", "GENERAL.TYPE:wifi\n")
    result = _run(
        tmp_path,
        'case "$(resolve_client_iface)" in wlan0) echo OK ;; *) echo FAIL ;; esac\n',
        extra_env={"CLAWBOX_CLIENT_IFACE": "wlan0"},
    )
    _assert_ok(result)


def test_resolve_client_iface_excludes_recovery(tmp_path: Path) -> None:
    _write(tmp_path, "nm.status", "wlan0ap:wifi\nwlan0:wifi\n")
    result = _run(
        tmp_path,
        'case "$(resolve_client_iface)" in wlan0) echo OK ;; *) echo FAIL ;; esac\n',
    )
    _assert_ok(result)


def test_hotspot_action_does_not_rechmod_data_directory() -> None:
    """创建 force_ap 父目录不能改掉安装器设置的组写权限。"""
    script = NET_ACTION.read_text(encoding="utf-8")
    hotspot_branch = script.split("  hotspot)", 1)[1].split("\n  wifi)", 1)[0]
    assert 'mkdir -p "$(dirname "$FORCE_AP_FLAG")"' in hotspot_branch
    assert '\n    install -d "$(dirname "$FORCE_AP_FLAG")"' not in hotspot_branch


def test_unknown_action_keeps_usage_path_free_of_bare_mkdir() -> None:
    """回退功能时不能把 hotspot 的 mkdir 错放进未知参数分支。"""
    script = NET_ACTION.read_text(encoding="utf-8")
    unknown_branch = script.split("\n  *)", 1)[1].split("\nesac", 1)[0]
    assert "mkdir -p" not in unknown_branch
    assert "用法:" in unknown_branch


def test_request_saved_wifi_connection_delegates_profile_choice(tmp_path: Path) -> None:
    """主动回连由 NetworkManager 选配置，不解析可能转义的中文 SSID。"""
    result = _run(
        tmp_path,
        'request_saved_wifi_connection wlan0 && echo OK || echo FAIL\n',
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().splitlines()[-1] == "OK"
    calls = (tmp_path / "net" / "connect-calls").read_text(encoding="utf-8")
    assert calls.strip() == "--wait 0 device connect wlan0"


def test_request_saved_wifi_connection_failure_keeps_fallback(tmp_path: Path) -> None:
    """nmcli 不支持主动请求时返回失败，让调用方继续原自动连接兜底。"""
    _write(tmp_path, "connect.fail", "1\n")
    result = _run(
        tmp_path,
        'request_saved_wifi_connection wlan0 && echo BAD || echo OK\n',
    )
    _assert_ok(result)
