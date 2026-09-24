"""hardware_selftest 的进程匹配安全性单测。"""

import builtins
import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "board-tools" / "hardware_selftest.py"
SPEC = importlib.util.spec_from_file_location("hardware_selftest", MODULE_PATH)
hardware_selftest = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(hardware_selftest)


def test_pids_of_matches_exact_script_argument(monkeypatch):
    class Result:
        stdout = "101\r\n102\r\n"

    monkeypatch.setattr(hardware_selftest.subprocess, "run", lambda *args, **kwargs: Result())
    cmdlines = {
        "/proc/101/cmdline": b"bash\0/opt/other/supervisor.sh\0",
        "/proc/102/cmdline": (f"bash\0{hardware_selftest.SUPERVISOR_CMD}\0").encode(),
    }

    class FakeFile:
        def __init__(self, data):
            self.data = data

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return self.data

    monkeypatch.setattr(builtins, "open", lambda path, mode: FakeFile(cmdlines[path]))

    assert hardware_selftest._pids_of(
        hardware_selftest.SUPERVISOR_CMD, "[s]upervisor.sh",
    ) == ["102"]
