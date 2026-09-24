"""power.py —— 电源动作必须避免与未退出的屏幕线程并发访问 SPI。"""

from types import SimpleNamespace

import power


class _Screen:
    available = True

    def __init__(self):
        self.clear_calls = 0

    def clear(self):
        self.clear_calls += 1


class _Worker:
    def __init__(self, stopped: bool):
        self.screen = _Screen()
        self.stopped = stopped
        self.timeouts = []

    def stop(self, timeout):
        self.timeouts.append(timeout)
        return self.stopped


def test_power_action_skips_clear_when_screen_thread_is_still_running(monkeypatch):
    worker = _Worker(stopped=False)
    state = SimpleNamespace(running=True, led=None)
    commands = []
    monkeypatch.setattr(power.subprocess, "run", lambda cmd, timeout: commands.append((cmd, timeout)))

    power.do_reboot(state, worker)

    assert state.running is False
    assert worker.timeouts == [power._SCREEN_STOP_TIMEOUT]
    assert worker.screen.clear_calls == 0
    assert commands == [(power.CMD_REBOOT, 5)] or commands == [([power.CMD_REBOOT], 5)]


def test_power_action_clears_after_screen_thread_stops(monkeypatch):
    worker = _Worker(stopped=True)
    state = SimpleNamespace(running=True, led=None)
    monkeypatch.setattr(power.subprocess, "run", lambda *args, **kwargs: None)

    power.do_shutdown(state, worker)

    assert worker.screen.clear_calls == 1


def test_power_action_keeps_running_when_command_fails(monkeypatch):
    """命令发起失败时不得置 running=False, 也不得停屏幕/清屏 —— 守护进程继续运行。

    背景: 旧实现先置 running=False 再执行命令, 命令失败会导致守护进程
    优雅退出且监督者不再拉起, 设备外设全灭 (2026-08-14 审查 P0-3)。
    """
    worker = _Worker(stopped=True)
    state = SimpleNamespace(running=True, led=None)

    def _fail(cmd, timeout):
        raise OSError("reboot failed")

    monkeypatch.setattr(power.subprocess, "run", _fail)

    result = power.do_reboot(state, worker)

    assert result is False
    assert state.running is True
    assert worker.timeouts == []
    assert worker.screen.clear_calls == 0
