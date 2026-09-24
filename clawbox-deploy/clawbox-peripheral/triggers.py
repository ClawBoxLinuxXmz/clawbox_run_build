"""
ClawBox 外设守护进程 —— QR/语言触发文件监听器
==============================================
前端 (Next.js) 通过写 JSON 文件通知墨水屏刷新:
  - chat-qr.json (新版, 含 platform/qr_type) + wechat-qr.json (旧版, 兼容)
  - locale.json (语言变化)

本模块只负责"检测 mtime 变化 + 解析校验 + 损坏文件清理",
不应用任何状态 —— 应用逻辑 (更新缓存/切页/切语言) 由 peripheral_daemon 决定,
便于在 PC 上对"解析+校验"逻辑做单测。
"""

import json
import logging
import os
import time
from typing import Dict, Optional

from validation import validate_qr_data_url, validate_qr_url

logger = logging.getLogger("clawbox.triggers")

# 刚写入(<1s)的文件可能还没写完, 跳过本轮, 等 mtime 再次变化时再读
_FRESH_WRITE_GRACE_S = 1.0


class TriggerWatcher:
    """QR 与语言触发文件监听器。

    Args:
        qr_files: [(key, path), ...], 按顺序检测 (新版 chat 优先)
        locale_file: locale.json 路径
        max_qr_file_bytes: QR 触发文件大小上限, 超出视为损坏删除
    """

    def __init__(self, qr_files, locale_file: str, max_qr_file_bytes: int):
        self._qr_files = list(qr_files)
        self._locale_file = locale_file
        self._max_qr_file_bytes = max_qr_file_bytes
        self._qr_mtimes: Dict[str, float] = {key: 0.0 for key, _ in self._qr_files}
        self._locale_mtime = 0.0

    # ============================================================
    # QR 触发文件
    # ============================================================

    def sync_qr_mtimes(self) -> None:
        """启动时同步各 QR 文件 mtime 基线。

        背景: 不 sync 则基线为 0, 重启后会误加载上次会话留下的过期二维码。
        """
        for key, path in self._qr_files:
            try:
                self._qr_mtimes[key] = os.path.getmtime(path)
            except OSError:
                pass

    def check_qr(self) -> Optional[Dict[str, str]]:
        """检测任一 QR 触发文件是否有新写入。

        Returns:
            有变化且内容有效时返回 {"key", "platform", "qr_url", "qr_type"};
            无变化或内容无效返回 None (无效文件已在内部清理)。

        关键：只有解析并校验成功才前移基线。半写/空/超限等失败时
        不更新基线，保证同秒重写的新文件不会被永久吞掉 (issue #4)。
        """
        for key, path in self._qr_files:
            try:
                st = os.stat(path)
            except OSError:
                continue
            mtime = st.st_mtime
            if mtime == self._qr_mtimes.get(key):
                # 文件系统粗粒度(秒级)可能同秒重写，额外比对大小避免“同 mtime 新内容被吞”。
                try:
                    if st.st_size == os.stat(path).st_size:
                        continue
                except OSError:
                    continue
            parsed = self._read_qr_trigger(path)
            if parsed is not None:
                self._qr_mtimes[key] = mtime
                parsed["key"] = key
                return parsed
            # 解析失败且文件已被删除（超限/空/损坏）：基线归零，下次新建必触发
            try:
                os.stat(path)
            except OSError:
                self._qr_mtimes[key] = 0.0
        return None

    def _read_qr_trigger(self, file_path: str) -> Optional[Dict[str, str]]:
        """读取并校验单个触发文件。损坏/超大文件会被删除。"""
        stat = self._stat_with_limit(file_path)
        if stat is None:
            return None
        raw, error = self._load_raw(file_path)
        if error is not None:
            return self._handle_qr_error(file_path, stat, error, remove=True)
        data = self._parse_qr_json(file_path, stat, raw)
        if data is None:
            return None
        return self._validate_qr_payload(file_path, data)

    def _stat_with_limit(self, file_path: str):
        try:
            stat = os.stat(file_path)
        except OSError:
            return None
        if stat.st_size > self._max_qr_file_bytes:
            logger.warning(f"QR 触发文件过大，已删除: {file_path}")
            try: os.remove(file_path)
            except OSError: pass
            return None
        return stat

    def _load_raw(self, file_path: str):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                raw = f.read(self._max_qr_file_bytes + 1).strip()
            if len(raw.encode("utf-8")) > self._max_qr_file_bytes:
                return None, ValueError("QR trigger file is too large")
            if not raw:
                return None, json.JSONDecodeError("空文件", "", 0)
            return raw, None
        except (OSError, UnicodeError) as e:
            return None, e

    def _parse_qr_json(self, file_path: str, stat, raw: str):
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError("QR trigger file must contain a JSON object")
            return data
        except (json.JSONDecodeError, ValueError) as e:
            return self._handle_qr_error(file_path, stat, e, remove=True)

    def _validate_qr_payload(self, file_path: str, data: dict) -> Optional[Dict[str, str]]:
        qr_type = data.get("qr_type", "url")
        qr_type = qr_type.strip().lower() if isinstance(qr_type, str) else "url"
        if qr_type not in ("url", "image"):
            qr_type = "url"
        qr_url = validate_qr_data_url(data.get("qr_url", "")) if qr_type == "image" else validate_qr_url(data.get("qr_url", ""))
        if data.get("qr_url") and not qr_url:
            logger.warning(f"QR 触发文件包含不允许的内容，已忽略: {file_path}")
            return None
        if not qr_url:
            return None
        platform = data.get("platform", "wechat")
        platform = platform.strip().lower() if isinstance(platform, str) else "wechat"
        return {"platform": platform, "qr_url": qr_url, "qr_type": qr_type}

    def _handle_qr_error(self, file_path: str, stat, exc: Exception, remove: bool = False):
        if isinstance(exc, json.JSONDecodeError):
            try:
                if time.time() - stat.st_mtime < _FRESH_WRITE_GRACE_S:
                    return None
            except OSError:
                return None
        if remove:
            logger.warning(f"QR 触发文件内容无效，已删除: {file_path} ({exc})")
            try: os.remove(file_path)
            except OSError: pass
        return None

    # ============================================================
    # 语言触发文件
    # ============================================================

    def sync_locale_mtime(self) -> None:
        """启动时同步 locale 文件 mtime 基线。

        背景: 启动流程已先读 locale.json 恢复上次语言, 不 sync 则基线为 0,
        主循环首轮会把它误判成一次"语言变化" (虽因值相同而不重绘, 但会白跑解析)。
        """
        try:
            self._locale_mtime = os.path.getmtime(self._locale_file)
        except OSError:
            pass

    def read_locale(self) -> Optional[str]:
        """直接读取当前 locale.json 的 locale 值 (启动恢复用, 不检查 mtime)。

        与 check_locale 的区别: 不更新/比较 mtime 基线。
        """
        parsed = self._read_locale_trigger(self._locale_file)
        return parsed["locale"] if parsed else None

    def check_locale(self) -> Optional[str]:
        """检测 locale.json 是否有新写入。

        Returns:
            有变化且含有效 locale 字段时返回原始 locale 字符串; 否则 None。
            注意: 不删除无效文件 (与 QR 不同) —— 前端用原子写, 下次语言变化
            会整体重写, 删除反而让 mtime 追踪和前端预期脱节。
        """
        try:
            mtime = os.stat(self._locale_file).st_mtime
        except OSError:
            return None
        if mtime == self._locale_mtime:
            return None
        self._locale_mtime = mtime
        parsed = self._read_locale_trigger(self._locale_file)
        if not parsed:
            return None
        return parsed["locale"]

    def _read_locale_trigger(self, file_path: str) -> Optional[dict]:
        """读取语言触发文件; 内容无效时返回 None。

        注意: 文件不存在(前端尚未创建)属正常状态, 静默返回不刷警告 (2026-08-24);
        只有文件存在但内容无效(坏 JSON/缺 locale 字段)才记录警告。
        """
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            raw = data.get("locale")
            if not isinstance(raw, str) or not raw.strip():
                logger.warning(f"语言触发文件缺少有效 locale 字段: {file_path}")
                return None
            return {"locale": raw.strip()}
        except FileNotFoundError:
            return None
        except (OSError, ValueError, TypeError, AttributeError) as e:
            logger.warning(f"语言触发文件内容无效: {file_path} ({e})")
            return None
