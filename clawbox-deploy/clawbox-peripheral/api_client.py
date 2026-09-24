"""
API 客户端 —— 与 clawbox_linux Next.js 后端通信
鲁棒性: 后端不可达时静默降级，返回默认值
"""

import json
import logging
import time
from typing import Any, Dict, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from config import API_BASE_URL, API_TIMEOUT

logger = logging.getLogger("clawbox.api")

_MAX_RESPONSE_BYTES = 1024 * 1024
_ALLOWED_API_SCHEMES = {"http", "https"}
# 连续失败时每隔多少次打一条 summary, 避免">3 次后完全静默"导致
# 日志里看不到"当前是否仍断着"的信号 (2026-08-11)
_ERROR_SUMMARY_EVERY = 20


def _read_limited_response(resp) -> bytes:
    raw_bytes = resp.read(_MAX_RESPONSE_BYTES + 1)
    if len(raw_bytes) > _MAX_RESPONSE_BYTES:
        raise ValueError("API response too large")
    return raw_bytes


def _normalize_base_url(base_url: str) -> str:
    if not isinstance(base_url, str) or not base_url.strip():
        raise ValueError("API URL must be a non-empty string")
    parsed = urlsplit(base_url.rstrip("/"))
    if parsed.scheme not in _ALLOWED_API_SCHEMES or not parsed.netloc:
        raise ValueError(f"Invalid API URL: {base_url!r}")
    if parsed.username or parsed.password:
        raise ValueError("API URL must not include credentials")
    return base_url.rstrip("/")


class ApiClient:
    """ClawBox API 客户端"""

    def __init__(self, base_url: str = API_BASE_URL, timeout: float = API_TIMEOUT):
        self._base_url = _normalize_base_url(base_url)
        self._timeout = timeout
        self._available = False
        self._last_error = ""
        self._consecutive_failures = 0

    # ---- 公开 API ----

    @property
    def available(self) -> bool:
        return self._available

    @property
    def last_error(self) -> str:
        return self._last_error

    def get_setup_status(self, timeout: Optional[float] = None) -> Dict[str, Any]:
        """
        GET /setup-api/setup/status
        返回设备设置状态
        """
        return self._get("/setup-api/setup/status", timeout=timeout)

    def get_wifi_status(self, timeout: Optional[float] = None) -> Dict[str, Any]:
        """
        GET /setup-api/wifi/status
        返回 WiFi 状态 (模式、SSID、IP等)
        """
        return self._get("/setup-api/wifi/status", timeout=timeout)

    def get_system_info(self, timeout: Optional[float] = None) -> Dict[str, Any]:
        """
        GET /setup-api/system/info
        返回系统信息
        """
        return self._get("/setup-api/system/info", timeout=timeout)

    # ---- 内部方法 ----

    def _get(self, path: str, timeout: Optional[float] = None) -> Dict[str, Any]:
        """发送 GET 请求"""
        return self._request("GET", path, timeout=timeout)

    def _request(self, method: str, path: str,
                 body: Optional[Dict] = None,
                 timeout: Optional[float] = None) -> Dict[str, Any]:
        """通用 HTTP 请求（带指数退避重试，仅对 5xx/超时重试）"""
        url = f"{self._base_url}{path}"
        t = timeout if timeout is not None else self._timeout

        last_error = ""
        for attempt in range(3):  # 最多 3 次尝试（1 次原始 + 2 次重试）
            try:
                data = None
                headers = {"Accept": "application/json"}

                if body is not None:
                    data = json.dumps(body).encode("utf-8")
                    headers["Content-Type"] = "application/json"

                req = Request(url, data=data, headers=headers, method=method)
                with urlopen(req, timeout=t) as resp:  # nosec B310
                    raw = _read_limited_response(resp).decode("utf-8")
                    result = json.loads(raw) if raw else {}

                self._available = True
                self._consecutive_failures = 0
                self._last_error = ""
                return result

            except HTTPError as e:
                # 4xx 不重试（客户端错误，重试无意义）
                if 400 <= e.code < 500:
                    self._handle_error(f"HTTP {e.code}: {e.reason}")
                    try:
                        raw = _read_limited_response(e)
                        # 兼容 HTTPError(fp=None) 的 mock 场景：e.read 可能返回 str（测试桩）
                        if isinstance(raw, str):
                            raw = raw.encode("utf-8")
                        body = raw.decode("utf-8")
                        return json.loads(body) if body else {"_error": str(e)}
                    except (ValueError, AttributeError, UnicodeDecodeError):
                        # 响应体超限/非法 JSON/非 UTF-8/类型异常: 视为解析失败, 返回错误摘要
                        return {"_error": str(e)}

                # 5xx 可重试
                last_error = f"HTTP {e.code}: {e.reason}"
                if attempt < 2:
                    wait = 0.5 * (attempt + 1)  # 0.5s, 1.0s
                    logger.debug(f"API 5xx 重试 ({attempt + 1}/2)，{wait:.1f}s 后重试: {last_error}")
                    time.sleep(wait)
                    continue

            except URLError as e:
                last_error = f"连接失败: {e.reason}"
                if attempt < 2:
                    wait = 0.5 * (attempt + 1)
                    logger.debug(f"API 连接重试 ({attempt + 1}/2)，{wait:.1f}s 后重试: {last_error}")
                    time.sleep(wait)
                    continue

            except json.JSONDecodeError:
                self._handle_error("响应不是有效的 JSON")
                return {"_error": "Invalid JSON response"}

            except Exception as e:
                self._handle_error(f"请求异常: {e}")
                return {"_error": str(e)}

        # 所有重试耗尽
        self._handle_error(last_error)
        return {"_error": last_error}

    def _handle_error(self, message: str) -> None:
        """统一错误处理，避免日志刷屏"""
        self._consecutive_failures += 1
        self._last_error = message

        if self._consecutive_failures == 1:
            # 首次失败
            logger.warning(f"API 不可达: {message}")
        elif self._consecutive_failures <= 3:
            logger.debug(f"API 请求失败 ({self._consecutive_failures}): {message}")
        # 连续失败中: 每 N 次打一条 summary, 让"当前是否断着"在日志里有信号 (2026-08-11)
        elif self._consecutive_failures % _ERROR_SUMMARY_EVERY == 0:
            logger.warning(
                f"API 已连续失败 {self._consecutive_failures} 次: {message}"
            )

        if self._consecutive_failures >= 5:
            self._available = False
