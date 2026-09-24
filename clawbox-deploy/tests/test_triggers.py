"""triggers.py —— TriggerWatcher 触发文件监听单测。

全部使用 tmp_path 临时文件, 不触碰真实 /home/clawbox 路径。
"""

import json

from triggers import TriggerWatcher


def _make_watcher(tmp_path, max_bytes=20000):
    qr = tmp_path / "chat-qr.json"
    legacy = tmp_path / "wechat-qr.json"
    locale = tmp_path / "locale.json"
    watcher = TriggerWatcher(
        qr_files=(("chat", str(qr)), ("legacy", str(legacy))),
        locale_file=str(locale),
        max_qr_file_bytes=max_bytes,
    )
    return watcher, qr, legacy, locale


# ---- QR 触发文件 ----

def test_check_qr_none_when_no_file(tmp_path):
    watcher, *_ = _make_watcher(tmp_path)
    assert watcher.check_qr() is None


def test_check_qr_parses_url_trigger(tmp_path):
    watcher, qr, *_ = _make_watcher(tmp_path)
    qr.write_text(
        json.dumps({"platform": "feishu", "qr_type": "url", "qr_url": "http://x.com/q"}),
        encoding="utf-8",
    )
    result = watcher.check_qr()
    assert result is not None
    assert result["platform"] == "feishu"
    assert result["qr_type"] == "url"
    assert result["qr_url"] == "http://x.com/q"
    assert result["key"] == "chat"
    # mtime 未变 → 第二次返回 None
    assert watcher.check_qr() is None


def test_check_qr_parses_image_trigger(tmp_path):
    watcher, qr, *_ = _make_watcher(tmp_path)
    qr.write_text(
        json.dumps({"platform": "whatsapp", "qr_type": "image",
                    "qr_url": "data:image/png;base64,iVBORw0KGgo="}),
        encoding="utf-8",
    )
    result = watcher.check_qr()
    assert result is not None
    assert result["qr_type"] == "image"
    assert result["platform"] == "whatsapp"


def test_check_qr_legacy_defaults_wechat(tmp_path):
    watcher, _, legacy, _ = _make_watcher(tmp_path)
    legacy.write_text(json.dumps({"qr_url": "http://x.com/wx"}), encoding="utf-8")
    result = watcher.check_qr()
    assert result is not None
    assert result["platform"] == "wechat"
    assert result["qr_type"] == "url"
    assert result["key"] == "legacy"


def test_check_qr_priority_chat_over_legacy(tmp_path):
    watcher, qr, legacy, _ = _make_watcher(tmp_path)
    qr.write_text(json.dumps({"platform": "qqbot", "qr_url": "http://x.com/q"}),
                  encoding="utf-8")
    legacy.write_text(json.dumps({"qr_url": "http://x.com/wx"}), encoding="utf-8")
    result = watcher.check_qr()
    assert result["key"] == "chat"
    assert result["platform"] == "qqbot"


def test_check_qr_rejects_disallowed_content_ignored_kept(tmp_path):
    """不允许的内容(如 ftp) → 忽略且不删除 (与原实现一致, 下次 mtime 变化再触发)。"""
    watcher, qr, *_ = _make_watcher(tmp_path)
    qr.write_text(json.dumps({"qr_url": "ftp://x.com"}), encoding="utf-8")
    assert watcher.check_qr() is None
    assert qr.exists()


def test_check_qr_deletes_oversized_file(tmp_path):
    watcher, qr, *_ = _make_watcher(tmp_path, max_bytes=10)
    qr.write_text(json.dumps({"qr_url": "http://x.com"}), encoding="utf-8")
    assert watcher.check_qr() is None
    assert not qr.exists()


def test_sync_qr_mtimes_prevents_reload(tmp_path):
    watcher, qr, *_ = _make_watcher(tmp_path)
    qr.write_text(json.dumps({"qr_url": "http://x.com/q"}), encoding="utf-8")
    watcher.sync_qr_mtimes()
    assert watcher.check_qr() is None   # 基线已同步, 启动后不误加载旧码


# ---- 语言触发文件 ----

def test_check_locale_returns_raw(tmp_path):
    watcher, *_, locale = _make_watcher(tmp_path)
    locale.write_text(json.dumps({"locale": "ko"}), encoding="utf-8")
    assert watcher.check_locale() == "ko"
    assert watcher.check_locale() is None   # mtime 未变


def test_read_locale_ignores_mtime(tmp_path):
    watcher, *_, locale = _make_watcher(tmp_path)
    locale.write_text(json.dumps({"locale": "en"}), encoding="utf-8")
    assert watcher.read_locale() == "en"
    assert watcher.read_locale() == "en"    # read_locale 不更新基线


def test_sync_locale_mtime_prevents_first_loop_trigger(tmp_path):
    watcher, *_, locale = _make_watcher(tmp_path)
    locale.write_text(json.dumps({"locale": "en"}), encoding="utf-8")
    watcher.sync_locale_mtime()
    assert watcher.check_locale() is None   # 启动已恢复语言, 首轮不误判变化


def test_check_locale_invalid_returns_none_keeps_file(tmp_path):
    watcher, *_, locale = _make_watcher(tmp_path)
    locale.write_text(json.dumps({"foo": "bar"}), encoding="utf-8")
    assert watcher.check_locale() is None
    assert locale.exists()   # 语言文件无效不删除 (与 QR 不同, 前端原子写整体重写)
