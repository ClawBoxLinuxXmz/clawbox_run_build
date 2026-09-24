"""
ApiClient 单元测试 —— 重试/退避/错误分类/响应限流 (mock urllib)
================================================================
2026-08-14 审查 P1-8: api_client 此前完全没有测试, 而它的重试/退避/
4xx 不重试/限流摘要都是纯逻辑, 应可单测。
"""

import io
from unittest import mock

import pytest
from urllib.error import HTTPError, URLError

from api_client import ApiClient, _normalize_base_url


# ============================================================
# 构造 HTTP 响应/错误的辅助函数
# ============================================================

def _ok_response(payload: bytes = b'{"wifi_mode": "client"}') -> mock.MagicMock:
    """构造一个成功响应的 urlopen 返回值 (带上下文管理器协议)。"""
    resp = mock.MagicMock()
    resp.read.return_value = payload
    return resp


def _http_error(code: int, body: bytes = b"") -> HTTPError:
    """构造带可读 body 的 HTTPError (与真实 urllib 行为一致)。"""
    return HTTPError(
        "http://127.0.0.1/setup-api/x", code, f"Error {code}", None,
        io.BytesIO(body),
    )


# ============================================================
# URL 规范化与安全
# ============================================================

def test_normalize_base_url_valid():
    assert _normalize_base_url("http://127.0.0.1:80/") == "http://127.0.0.1:80"


def test_normalize_rejects_non_http_scheme():
    with pytest.raises(ValueError):
        _normalize_base_url("ftp://127.0.0.1")


def test_normalize_rejects_empty():
    with pytest.raises(ValueError):
        _normalize_base_url("   ")


def test_normalize_rejects_credentials():
    # 含凭据的 API 地址必须拒绝: 防止把密码写进请求 URL/日志
    with pytest.raises(ValueError):
        _normalize_base_url("http://user:pass@127.0.0.1:80")


# ============================================================
# 请求与重试
# ============================================================

def test_request_success(monkeypatch):
    urlopen = mock.MagicMock()
    urlopen.return_value.__enter__.return_value = _ok_response()
    monkeypatch.setattr("api_client.urlopen", urlopen)
    api = ApiClient("http://127.0.0.1:80")

    result = api.get_setup_status()

    assert result == {"wifi_mode": "client"}
    assert api.available is True
    assert urlopen.call_count == 1


def test_5xx_retries_then_success(monkeypatch):
    """5xx 重试 2 次 (共 3 次尝试), 间隔 0.5s/1.0s。"""
    urlopen = mock.MagicMock()
    urlopen.return_value.__enter__.side_effect = [
        _http_error(500),
        _http_error(500),
        _ok_response(),
    ]
    sleep = mock.MagicMock()
    monkeypatch.setattr("api_client.urlopen", urlopen)
    monkeypatch.setattr("time.sleep", sleep)
    api = ApiClient("http://127.0.0.1:80")

    result = api.get_setup_status()

    assert result == {"wifi_mode": "client"}
    assert urlopen.call_count == 3
    assert [c.args[0] for c in sleep.call_args_list] == [0.5, 1.0]


def test_5xx_exhausted_returns_error(monkeypatch):
    urlopen = mock.MagicMock()
    urlopen.return_value.__enter__.side_effect = [_http_error(500)] * 3
    monkeypatch.setattr("api_client.urlopen", urlopen)
    monkeypatch.setattr("time.sleep", mock.MagicMock())
    api = ApiClient("http://127.0.0.1:80")

    result = api.get_setup_status()

    assert "_error" in result
    assert "500" in result["_error"]
    assert urlopen.call_count == 3
    assert api.available is False  # 失败超过阈值后标记不可用


def test_4xx_no_retry_returns_parsed_body(monkeypatch):
    """4xx 是客户端错误, 重试无意义: 只请求 1 次, 且解析响应 body。"""
    urlopen = mock.MagicMock()
    urlopen.return_value.__enter__.side_effect = [
        _http_error(401, b'{"error": "unauthorized"}'),
    ]
    sleep = mock.MagicMock()
    monkeypatch.setattr("api_client.urlopen", urlopen)
    monkeypatch.setattr("time.sleep", sleep)
    api = ApiClient("http://127.0.0.1:80")

    result = api.get_setup_status()

    assert result == {"error": "unauthorized"}
    assert urlopen.call_count == 1
    sleep.assert_not_called()


def test_connection_error_retries(monkeypatch):
    urlopen = mock.MagicMock()
    urlopen.return_value.__enter__.side_effect = [
        URLError("connection refused"),
        _ok_response(),
    ]
    monkeypatch.setattr("api_client.urlopen", urlopen)
    monkeypatch.setattr("time.sleep", mock.MagicMock())
    api = ApiClient("http://127.0.0.1:80")

    result = api.get_setup_status()

    assert result == {"wifi_mode": "client"}
    assert urlopen.call_count == 2


def test_invalid_json_returns_error_no_crash(monkeypatch):
    urlopen = mock.MagicMock()
    urlopen.return_value.__enter__.return_value = _ok_response(b"<html>oops</html>")
    monkeypatch.setattr("api_client.urlopen", urlopen)
    api = ApiClient("http://127.0.0.1:80")

    result = api.get_setup_status()

    assert result == {"_error": "Invalid JSON response"}


def test_oversized_response_rejected(monkeypatch):
    """超过 1MB 的响应必须拒绝, 防止后端异常时把内存/屏幕流程拖垮。"""
    urlopen = mock.MagicMock()
    urlopen.return_value.__enter__.return_value = _ok_response(b"x" * (1024 * 1024 + 1))
    monkeypatch.setattr("api_client.urlopen", urlopen)
    api = ApiClient("http://127.0.0.1:80")

    result = api.get_setup_status()

    assert "_error" in result


def test_empty_body_returns_empty_dict(monkeypatch):
    urlopen = mock.MagicMock()
    urlopen.return_value.__enter__.return_value = _ok_response(b"")
    monkeypatch.setattr("api_client.urlopen", urlopen)
    api = ApiClient("http://127.0.0.1:80")

    assert api.get_setup_status() == {}


# ============================================================
# 错误日志限流 (连续失败摘要)
# ============================================================

def test_error_summary_logged_every_20_failures(monkeypatch, caplog):
    """连续失败第 20 次打一条 summary, 避免日志静默失去'仍断着'的信号。"""
    import logging
    caplog.set_level(logging.WARNING)
    api = ApiClient("http://127.0.0.1:80")

    for _ in range(20):
        api._handle_error("down")

    # 1 (首次) + 20 (每 20 次摘要) = 2 条 WARNING; 其余走 debug
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 2
    assert "连续失败 20 次" in warnings[-1].message


def test_available_flips_on_success_after_failures(monkeypatch):
    urlopen = mock.MagicMock()
    urlopen.return_value.__enter__.side_effect = [
        _http_error(500), _http_error(500), _http_error(500),
    ]
    monkeypatch.setattr("api_client.urlopen", urlopen)
    monkeypatch.setattr("time.sleep", mock.MagicMock())
    api = ApiClient("http://127.0.0.1:80")
    api.get_setup_status()
    assert api.available is False

    # 之后成功 → available 恢复 True, 失败计数清零
    urlopen.return_value.__enter__.side_effect = [_ok_response()]
    api.get_setup_status()
    assert api.available is True
