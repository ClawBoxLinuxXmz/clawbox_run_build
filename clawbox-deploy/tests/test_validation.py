"""validation.py —— 输入校验纯函数单测。"""

import validation


# ---- env_int ----

def test_env_int_default_when_missing(monkeypatch):
    monkeypatch.delenv("CLAWBOX_TEST_INT", raising=False)
    assert validation.env_int("CLAWBOX_TEST_INT", 5, 0, 10) == 5


def test_env_int_parses_valid(monkeypatch):
    monkeypatch.setenv("CLAWBOX_TEST_INT", "7")
    assert validation.env_int("CLAWBOX_TEST_INT", 5, 0, 10) == 7


def test_env_int_invalid_falls_back(monkeypatch):
    monkeypatch.setenv("CLAWBOX_TEST_INT", "abc")
    assert validation.env_int("CLAWBOX_TEST_INT", 5, 0, 10) == 5


def test_env_int_clamps_to_range(monkeypatch):
    monkeypatch.setenv("CLAWBOX_TEST_INT", "99")
    assert validation.env_int("CLAWBOX_TEST_INT", 5, 0, 10) == 10
    monkeypatch.setenv("CLAWBOX_TEST_INT", "-3")
    assert validation.env_int("CLAWBOX_TEST_INT", 5, 0, 10) == 0


# ---- parse_allowed_schemes ----

def test_parse_allowed_schemes_ok():
    assert validation.parse_allowed_schemes("http,https,ws") == {"http", "https", "ws"}


def test_parse_allowed_schemes_ignores_bad_items():
    assert validation.parse_allowed_schemes("http,,1abc,-x,") == {"http"}


def test_parse_allowed_schemes_all_invalid_falls_back():
    assert validation.parse_allowed_schemes("1abc,-x,!!") == {"http", "https"}


# ---- validate_qr_url ----

def test_validate_qr_url_valid_http():
    assert validation.validate_qr_url(" http://192.168.1.1/setup ") == "http://192.168.1.1/setup"


def test_validate_qr_url_rejects_non_http_scheme():
    assert validation.validate_qr_url("ftp://x.com") == ""


def test_validate_qr_url_rejects_credentials():
    assert validation.validate_qr_url("http://user:pass@x.com") == ""


def test_validate_qr_url_rejects_non_string():
    assert validation.validate_qr_url(123) == ""


def test_validate_qr_url_rejects_empty():
    assert validation.validate_qr_url("  ") == ""


def test_validate_qr_url_rejects_no_netloc():
    assert validation.validate_qr_url("http://") == ""


def test_validate_qr_url_rejects_too_long():
    long_url = "http://x.com/" + "a" * 3000
    assert validation.validate_qr_url(long_url) == ""


# ---- validate_qr_data_url ----

def test_validate_qr_data_url_ok():
    url = "data:image/png;base64,iVBORw0KGgo="
    assert validation.validate_qr_data_url(url) == url


def test_validate_qr_data_url_rejects_wrong_prefix():
    assert validation.validate_qr_data_url("data:image/jpeg;base64,AAA=") == ""


def test_validate_qr_data_url_rejects_bad_base64():
    assert validation.validate_qr_data_url("data:image/png;base64,!!bad!!") == ""


def test_validate_qr_data_url_rejects_empty_b64():
    assert validation.validate_qr_data_url("data:image/png;base64,") == ""


def test_validate_qr_data_url_rejects_non_string():
    assert validation.validate_qr_data_url(None) == ""
