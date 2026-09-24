"""install.sh CONFIG_DEFAULTS 与 config.py/validation.py 默认值一致性测试。

背景: 守护进程可调参数的默认值分散在 install.sh(CONFIG_DEFAULTS) 与
config.py/validation.py(os.environ 默认) 两处维护, 历史曾因只改一处导致
旧 env 压住新默认 (8.11 QR_FILE_MAX_BYTES 8192 vs 20000)。本测试静态比对
两处源码字面量, 防漂移 (2026-08-14 审查 P1-2)。
"""

import re
from pathlib import Path

PERIPHERAL_DIR = Path(__file__).resolve().parents[1] / "clawbox-peripheral"


def _env_get_default(src: str, key: str) -> str:
    m = re.search(rf'os\.environ\.get\("{key}",\s*"([^"]*)"\)', src)
    assert m, f"源码中未找到 {key} 的 os.environ.get 默认值"
    return m.group(1)


def _env_int_default(src: str, key: str) -> str:
    m = re.search(rf'env_int\("{key}",\s*(\d+)', src)
    assert m, f"源码中未找到 {key} 的 env_int 默认值"
    return m.group(1)


def test_installer_config_defaults_match_code_defaults() -> None:
    installer = (PERIPHERAL_DIR / "install.sh").read_text(encoding="utf-8")
    config_src = (PERIPHERAL_DIR / "config.py").read_text(encoding="utf-8")
    validation_src = (PERIPHERAL_DIR / "validation.py").read_text(encoding="utf-8")

    defaults = dict(
        re.findall(r'^    "(CLAWBOX_[A-Z_]+)=(.*)"$', installer, re.MULTILINE)
    )

    assert defaults["CLAWBOX_API_URL"] == _env_get_default(config_src, "CLAWBOX_API_URL")
    assert defaults["CLAWBOX_QR_MAX_LENGTH"] == _env_int_default(validation_src, "CLAWBOX_QR_MAX_LENGTH")
    assert defaults["CLAWBOX_QR_FILE_MAX_BYTES"] == _env_int_default(validation_src, "CLAWBOX_QR_FILE_MAX_BYTES")
    assert defaults["CLAWBOX_QR_ALLOWED_SCHEMES"] == _env_get_default(validation_src, "CLAWBOX_QR_ALLOWED_SCHEMES")
