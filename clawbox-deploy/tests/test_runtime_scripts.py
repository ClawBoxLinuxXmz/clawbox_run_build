"""启动脚本契约测试：配置文件必须进入守护进程的子进程环境。"""

import os
from pathlib import Path
import re
import shutil
import subprocess
import time

import pytest


PERIPHERAL_DIR = Path(__file__).resolve().parents[1] / "clawbox-peripheral"


def test_runtime_env_exports_default_file_values(tmp_path: Path) -> None:
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is required for shell entrypoint tests")

    env_file = tmp_path / "clawbox-peripheral"
    env_file.write_text(
        "\n".join(
            (
                "CONFIG_VERSION=2",
                "CLAWBOX_API_URL=http://127.0.0.1:18080",
                "CLAWBOX_QR_MAX_LENGTH=4096",
                "CLAWBOX_LIVE_MARK=/run/clawbox-test.live",
            )
        )
        + "\n",
        encoding="utf-8",
    )

    env = os.environ.copy()
    env["CLAWBOX_ENV_FILE"] = str(env_file)
    result = subprocess.run(
        [
            bash,
            "-c",
            '. "$1" && env | grep "^CLAWBOX_"',
            "runtime-env-test",
            str(PERIPHERAL_DIR / "runtime_env.sh"),
        ],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )
    exported = dict(
        line.split("=", 1)
        for line in result.stdout.splitlines()
        if "=" in line
    )

    assert exported["CLAWBOX_API_URL"] == "http://127.0.0.1:18080"
    assert exported["CLAWBOX_QR_MAX_LENGTH"] == "4096"
    assert exported["CLAWBOX_LIVE_MARK"] == "/run/clawbox-test.live"


def test_all_entrypoints_use_the_shared_runtime_environment() -> None:
    supervisor = (PERIPHERAL_DIR / "supervisor.sh").read_text(encoding="utf-8")
    restart = (PERIPHERAL_DIR / "restart_daemon.sh").read_text(encoding="utf-8")
    service = (PERIPHERAL_DIR / "clawbox-peripheral.service").read_text(
        encoding="utf-8"
    )

    assert '. "$SCRIPT_DIR/runtime_env.sh"' in supervisor
    assert '. "$SCRIPT_DIR/runtime_env.sh"' in restart
    assert "EnvironmentFile=-/etc/default/clawbox-peripheral" in service
    assert "Restart=on-failure" in service
    assert 'wait "$daemon_pid"' in supervisor
    # 2026-08-26 契约重构: 无停止标记总是拉起(0/非零/信号), 有标记才退出
    assert 'STOP_FLAG' in supervisor
    assert '[ -f "$STOP_FLAG" ]' in supervisor
    assert 'nohup bash "$SUPERVISOR_SH"' in restart
    assert "STARTUP_REPORT_DELAY_SECONDS=6" in restart
    assert 'sleep "$STARTUP_REPORT_DELAY_SECONDS"' in restart


def test_supervisor_restarts_nonzero_exit_without_live_mark(tmp_path: Path) -> None:
    """启动即失败时尚无 live mark，也必须靠真实退出码拉起 (无停止标记契约)。"""
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is required for supervisor integration tests")

    counter = tmp_path / "runs"
    daemon = tmp_path / "fake-daemon.sh"
    daemon.write_text(
        "#!/usr/bin/env bash\n"
        f'counter="{counter.as_posix()}"\n'
        'runs=0; [ -f "$counter" ] && runs=$(cat "$counter")\n'
        'runs=$((runs + 1)); echo "$runs" > "$counter"\n'
        '[ "$runs" -eq 1 ] && exit 17\n'
        # 第二次运行创建停止标记: 新契约下 exit 0 无标记也会被拉起,
        # 用标记让监督者按"应当死去"退出, 避免无限循环 (2026-08-26)
        '[ "$runs" -eq 2 ] && touch "$CLAWBOX_STOP_FLAG"\n'
        'exit 0\n',
        encoding="utf-8",
    )
    crash_log = tmp_path / "crash.log"
    stop_flag = tmp_path / "stop-flag"
    env = os.environ.copy()
    env.update(
        {
            "CLAWBOX_ENV_FILE": str(tmp_path / "missing-env"),
            "CLAWBOX_DAEMON_SCRIPT": str(daemon),
            "CLAWBOX_PYTHON_BIN": bash,
            "CLAWBOX_CRASH_LOG": str(crash_log),
            "CLAWBOX_CRASH_BACKOFF_AFTER": "5",
            "CLAWBOX_CRASH_BACKOFF_SECONDS": "0",
            "CLAWBOX_CRASH_STABLE_SECONDS": "300",
            "CLAWBOX_PROCESS_POLL_EVERY": "0.05",
            "CLAWBOX_STOP_FLAG": str(stop_flag),
        }
    )

    result = subprocess.run(
        [bash, str(PERIPHERAL_DIR / "supervisor.sh")],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=10,
    )

    assert result.returncode == 0
    assert counter.read_text(encoding="utf-8").strip() == "2"
    log = crash_log.read_text(encoding="utf-8")
    assert "守护进程退出(status=17" in log
    assert "检测到停止标记" in log


def test_supervisor_restarts_on_zero_exit_without_stop_flag(tmp_path: Path) -> None:
    """核心修复 (2026-08-26): 无停止标记时, 守护进程 status=0 优雅退出也必须重启。

    压测发现: 误发 SIGTERM → 守护进程优雅退出(status=0) → 旧逻辑"0 不重启"
    导致监督者也退出 → 设备永久哑掉。新契约: 无标记 = 应当活着, 无论退出码。
    """
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is required for supervisor integration tests")

    counter = tmp_path / "runs"
    daemon = tmp_path / "fake-daemon.sh"
    daemon.write_text(
        "#!/usr/bin/env bash\n"
        f'counter="{counter.as_posix()}"\n'
        'runs=0; [ -f "$counter" ] && runs=$(cat "$counter")\n'
        'runs=$((runs + 1)); echo "$runs" > "$counter"\n'
        # 第二次运行创建停止标记: 验证"第一次 status=0 被拉起"后按"应当死去"退出
        '[ "$runs" -eq 2 ] && touch "$CLAWBOX_STOP_FLAG"\n'
        'exit 0\n',  # 每次都优雅退出
        encoding="utf-8",
    )
    crash_log = tmp_path / "crash.log"
    stop_flag = tmp_path / "stop-flag"
    env = os.environ.copy()
    env.update(
        {
            "CLAWBOX_ENV_FILE": str(tmp_path / "missing-env"),
            "CLAWBOX_DAEMON_SCRIPT": str(daemon),
            "CLAWBOX_PYTHON_BIN": bash,
            "CLAWBOX_CRASH_LOG": str(crash_log),
            "CLAWBOX_CRASH_BACKOFF_AFTER": "5",
            "CLAWBOX_CRASH_BACKOFF_SECONDS": "0",
            "CLAWBOX_CRASH_STABLE_SECONDS": "300",
            "CLAWBOX_PROCESS_POLL_EVERY": "0.05",
            "CLAWBOX_STOP_FLAG": str(stop_flag),  # 初始不存在
        }
    )

    result = subprocess.run(
        [bash, str(PERIPHERAL_DIR / "supervisor.sh")],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=10,
    )

    assert result.returncode == 0
    assert counter.read_text(encoding="utf-8").strip() == "2"  # 优雅退出也被拉起
    log = crash_log.read_text(encoding="utf-8")
    assert "守护进程退出(status=0" in log
    assert "重新拉起" in log


def test_supervisor_exits_on_zero_with_stop_flag(tmp_path: Path) -> None:
    """应当死去时死去: 存在停止标记 + status=0 → 监督者退出不拉起。"""
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is required for supervisor integration tests")

    counter = tmp_path / "runs"
    daemon = tmp_path / "fake-daemon.sh"
    daemon.write_text(
        "#!/usr/bin/env bash\n"
        f'counter="{counter.as_posix()}"\n'
        'runs=0; [ -f "$counter" ] && runs=$(cat "$counter")\n'
        'runs=$((runs + 1)); echo "$runs" > "$counter"\n'
        'exit 0\n',
        encoding="utf-8",
    )
    crash_log = tmp_path / "crash.log"
    stop_flag = tmp_path / "stop-flag"
    stop_flag.write_text("", encoding="utf-8")  # 停止标记存在
    env = os.environ.copy()
    env.update(
        {
            "CLAWBOX_ENV_FILE": str(tmp_path / "missing-env"),
            "CLAWBOX_DAEMON_SCRIPT": str(daemon),
            "CLAWBOX_PYTHON_BIN": bash,
            "CLAWBOX_CRASH_LOG": str(crash_log),
            "CLAWBOX_CRASH_BACKOFF_AFTER": "5",
            "CLAWBOX_CRASH_BACKOFF_SECONDS": "0",
            "CLAWBOX_CRASH_STABLE_SECONDS": "300",
            "CLAWBOX_PROCESS_POLL_EVERY": "0.05",
            "CLAWBOX_STOP_FLAG": str(stop_flag),
        }
    )

    result = subprocess.run(
        [bash, str(PERIPHERAL_DIR / "supervisor.sh")],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=10,
    )

    assert result.returncode == 0
    assert counter.read_text(encoding="utf-8").strip() == "1"  # 只跑一次, 不拉起
    log = crash_log.read_text(encoding="utf-8")
    assert "检测到停止标记" in log


def test_supervisor_exits_on_signal_with_stop_flag(tmp_path: Path) -> None:
    """应当死去时死去: 存在停止标记 + 被信号杀死 → 监督者退出不拉起。"""
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is required for supervisor integration tests")

    counter = tmp_path / "runs"
    daemon = tmp_path / "fake-daemon.sh"
    daemon.write_text(
        "#!/usr/bin/env bash\n"
        f'counter="{counter.as_posix()}"\n'
        'runs=0; [ -f "$counter" ] && runs=$(cat "$counter")\n'
        'runs=$((runs + 1)); echo "$runs" > "$counter"\n'
        'kill -TERM $$ 2>/dev/null\n'  # 模拟被 SIGTERM 杀死 (status=143)
        'exit 0\n',
        encoding="utf-8",
    )
    crash_log = tmp_path / "crash.log"
    stop_flag = tmp_path / "stop-flag"
    stop_flag.write_text("", encoding="utf-8")  # 停止标记存在
    env = os.environ.copy()
    env.update(
        {
            "CLAWBOX_ENV_FILE": str(tmp_path / "missing-env"),
            "CLAWBOX_DAEMON_SCRIPT": str(daemon),
            "CLAWBOX_PYTHON_BIN": bash,
            "CLAWBOX_CRASH_LOG": str(crash_log),
            "CLAWBOX_CRASH_BACKOFF_AFTER": "5",
            "CLAWBOX_CRASH_BACKOFF_SECONDS": "0",
            "CLAWBOX_CRASH_STABLE_SECONDS": "300",
            "CLAWBOX_PROCESS_POLL_EVERY": "0.05",
            "CLAWBOX_STOP_FLAG": str(stop_flag),
        }
    )

    result = subprocess.run(
        [bash, str(PERIPHERAL_DIR / "supervisor.sh")],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=10,
    )

    assert result.returncode == 0
    assert counter.read_text(encoding="utf-8").strip() == "1"  # 只跑一次, 不拉起
    log = crash_log.read_text(encoding="utf-8")
    assert "检测到停止标记" in log


def test_supervisor_kills_stale_daemon_and_restarts(tmp_path: Path) -> None:
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is required for supervisor integration tests")

    counter = tmp_path / "runs"
    daemon = tmp_path / "fake-daemon.sh"
    daemon.write_text(
        "#!/usr/bin/env bash\n"
        f'counter="{counter.as_posix()}"\n'
        'runs=0; [ -f "$counter" ] && runs=$(cat "$counter")\n'
        'runs=$((runs + 1)); echo "$runs" > "$counter"\n'
        '[ "$runs" -eq 1 ] && sleep 20\n'
        # 第二次运行创建停止标记: 新契约下 exit 0 无标记也会被拉起 (2026-08-26)
        '[ "$runs" -eq 2 ] && touch "$CLAWBOX_STOP_FLAG"\n'
        'exit 0\n',
        encoding="utf-8",
    )
    crash_log = tmp_path / "crash.log"
    # 真"卡死"场景: 心跳文件存在但过期(uptime 记录 0 → age 立即 >= stale)。
    # 用存在但过期的心跳文件(而非缺失)测试 stale 判定路径 (2026-08-24 修复后)。
    heartbeat_file = tmp_path / "stale-heartbeat"
    heartbeat_file.write_text("0.000 1\n", encoding="utf-8")
    env = os.environ.copy()
    env.update(
        {
            "CLAWBOX_ENV_FILE": str(tmp_path / "missing-env"),
            "CLAWBOX_DAEMON_SCRIPT": str(daemon),
            "CLAWBOX_PYTHON_BIN": bash,
            "CLAWBOX_CRASH_LOG": str(crash_log),
            "CLAWBOX_HEARTBEAT_FILE": str(heartbeat_file),
            "CLAWBOX_HEARTBEAT_GRACE": "0",
            "CLAWBOX_HEARTBEAT_STALE": "1",
            "CLAWBOX_HEARTBEAT_CHECK_EVERY": "1",
            "CLAWBOX_PROCESS_POLL_EVERY": "0.05",
            "CLAWBOX_CRASH_BACKOFF_AFTER": "5",
            "CLAWBOX_CRASH_BACKOFF_SECONDS": "0",
            "CLAWBOX_STOP_FLAG": str(tmp_path / "stop-flag"),
        }
    )

    result = subprocess.run(
        [bash, str(PERIPHERAL_DIR / "supervisor.sh")],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=10,
    )

    assert result.returncode == 0
    assert counter.read_text(encoding="utf-8").strip() == "2"
    log = crash_log.read_text(encoding="utf-8")
    assert "[watchdog] 心跳超时" in log
    assert "守护进程退出(status=137" in log


def test_supervisor_missing_heartbeat_buffered_then_kills(tmp_path: Path) -> None:
    """心跳文件缺失: 先缓冲(不立即判死), 持续缺失超过缓冲上限才 kill (2026-08-24 修复)。"""
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is required for supervisor integration tests")

    counter = tmp_path / "runs"
    daemon = tmp_path / "fake-daemon.sh"
    daemon.write_text(
        "#!/usr/bin/env bash\n"
        f'counter="{counter.as_posix()}"\n'
        'runs=0; [ -f "$counter" ] && runs=$(cat "$counter")\n'
        'runs=$((runs + 1)); echo "$runs" > "$counter"\n'
        '[ "$runs" -eq 1 ] && sleep 20\n'
        # 第二次运行创建停止标记: 新契约下 exit 0 无标记也会被拉起 (2026-08-26)
        '[ "$runs" -eq 2 ] && touch "$CLAWBOX_STOP_FLAG"\n'
        'exit 0\n',
        encoding="utf-8",
    )
    crash_log = tmp_path / "crash.log"
    env = os.environ.copy()
    env.update(
        {
            "CLAWBOX_ENV_FILE": str(tmp_path / "missing-env"),
            "CLAWBOX_DAEMON_SCRIPT": str(daemon),
            "CLAWBOX_PYTHON_BIN": bash,
            "CLAWBOX_CRASH_LOG": str(crash_log),
            "CLAWBOX_HEARTBEAT_FILE": str(tmp_path / "missing-heartbeat"),
            "CLAWBOX_HEARTBEAT_GRACE": "0",
            "CLAWBOX_HEARTBEAT_STALE": "1",
            "CLAWBOX_HEARTBEAT_CHECK_EVERY": "1",
            "CLAWBOX_HEARTBEAT_MISSING_TIMEOUT": "1",
            "CLAWBOX_PROCESS_POLL_EVERY": "0.05",
            "CLAWBOX_CRASH_BACKOFF_AFTER": "5",
            "CLAWBOX_CRASH_BACKOFF_SECONDS": "0",
            "CLAWBOX_STOP_FLAG": str(tmp_path / "stop-flag"),
        }
    )

    result = subprocess.run(
        [bash, str(PERIPHERAL_DIR / "supervisor.sh")],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=10,
    )

    assert result.returncode == 0
    assert counter.read_text(encoding="utf-8").strip() == "2"
    log = crash_log.read_text(encoding="utf-8")
    assert "[watchdog] 心跳文件缺失" in log
    assert "守护进程退出(status=137" in log


def _run_watchdog_probe(tmp_path: Path, heartbeat: str | None) -> subprocess.CompletedProcess:
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is required for watchdog probe tests")
    live_mark = tmp_path / "daemon.live"
    heartbeat_file = tmp_path / "daemon.heartbeat"
    if heartbeat is not None:
        heartbeat_file.write_text(heartbeat, encoding="utf-8")
    env = os.environ.copy()
    env.update(
        {
            "CLAWBOX_LIVE_MARK": str(live_mark),
            "CLAWBOX_HEARTBEAT_FILE": str(heartbeat_file),
            "CLAWBOX_HEARTBEAT_STALE": "30",
            "CLAWBOX_HEARTBEAT_GRACE": "60",
        }
    )
    return subprocess.run(
        [
            bash,
            "-c",
            'printf "%s %s\\n" "$$" "$(cut -d\' \' -f1 /proc/uptime)" > "$1"; exec "$2"',
            "watchdog-probe-test",
            str(live_mark),
            str(PERIPHERAL_DIR / "watchdog_probe.sh"),
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )


def _bash_uptime() -> float:
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is required for watchdog probe tests")
    result = subprocess.run(
        [bash, "-c", "cut -d' ' -f1 /proc/uptime"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return float(result.stdout.strip())


def test_watchdog_probe_accepts_fresh_heartbeat(tmp_path: Path) -> None:
    uptime = _bash_uptime()
    result = _run_watchdog_probe(tmp_path, f"{uptime} {int(time.time())}\n")
    assert result.returncode == 0


def test_watchdog_probe_rejects_stale_heartbeat_even_when_file_is_new(tmp_path: Path) -> None:
    uptime = _bash_uptime()
    result = _run_watchdog_probe(
        tmp_path,
        f"{uptime - 90:.3f} {int(time.time())}\n",
    )
    assert result.returncode == 2
    assert "watchdog stale" in result.stderr


def test_installer_exits_nonzero_before_success_when_daemon_is_missing() -> None:
    installer = (PERIPHERAL_DIR / "install.sh").read_text(encoding="utf-8")
    failure_branch = re.search(
        r'else\s+echo -e "  \$\{RED\}❌ 守护进程未能启动.*?\n(.*?)\nfi',
        installer,
        re.DOTALL,
    )

    assert failure_branch is not None
    assert "exit 1" in failure_branch.group(1)
    assert installer.index("exit 1", failure_branch.start()) < installer.index("部署完成")


def test_installer_declares_opencv_for_high_density_qr() -> None:
    installer = (PERIPHERAL_DIR / "install.sh").read_text(encoding="utf-8")

    assert (
        'install_python_module "cv2" "opencv-python-headless" "python3-opencv"'
        in installer
    )


def test_installer_updates_apt_only_when_system_packages_are_missing() -> None:
    installer = (PERIPHERAL_DIR / "install.sh").read_text(encoding="utf-8")
    dependency_section = installer.split("[2/6] 安装系统依赖", 1)[1].split(
        "[3/6] 安装 Python 依赖", 1
    )[0]

    condition = 'if [ "${#missing_system_packages[@]}" -gt 0 ]; then'
    assert "dpkg-query -W" in dependency_section
    assert condition in dependency_section
    assert dependency_section.index(condition) < dependency_section.index("apt-get update -qq")
    assert 'apt-get install -y -qq "${missing_system_packages[@]}"' in dependency_section
