from app.config import get_api_config, get_config


def test_get_config_reads_environment(monkeypatch):
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://example:secret@localhost:5432/example",
    )
    monkeypatch.setenv("BASE_URL", "https://example.test")
    monkeypatch.setenv("PER_PAGE", "32")
    monkeypatch.setenv("REQUEST_DELAY_MIN", "1.1")
    monkeypatch.setenv("REQUEST_DELAY_MAX", "3.3")
    monkeypatch.setenv("HTTP_TIMEOUT", "15")
    monkeypatch.setenv("USER_AGENT", "TestAgent/1.0")

    config = get_config()

    assert config.database_url == "postgresql://example:secret@localhost:5432/example"
    assert config.base_url == "https://example.test"
    assert config.per_page == 32
    assert config.delay_min == 1.1
    assert config.delay_max == 3.3
    assert config.timeout == 15.0
    assert config.user_agent == "TestAgent/1.0"


def _set_required_api_env(monkeypatch):
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://example:secret@localhost:5432/example",
    )
    monkeypatch.setenv("ADMIN_USERNAME", "admin")
    monkeypatch.setenv("ADMIN_PASSWORD_HASH", "$argon2id$test")
    monkeypatch.setenv("JWT_SECRET", "test-secret-with-at-least-32-bytes")


def test_get_api_config_static_defaults(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    _set_required_api_env(monkeypatch)
    monkeypatch.delenv("STATIC_ASSETS_ROOT", raising=False)
    monkeypatch.delenv("STATIC_ASSETS_URL_PREFIX", raising=False)
    monkeypatch.delenv("PUBLIC_API_BASE_URL", raising=False)

    config = get_api_config()

    assert config.static_assets_root == "storage/images"
    assert config.static_assets_url_prefix == "/static/images"
    assert config.public_api_base_url == "http://127.0.0.1:8000"


def test_get_api_config_reads_static_overrides(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    _set_required_api_env(monkeypatch)
    monkeypatch.setenv("STATIC_ASSETS_ROOT", "custom/images")
    monkeypatch.setenv("STATIC_ASSETS_URL_PREFIX", "/assets/images")
    monkeypatch.setenv("PUBLIC_API_BASE_URL", "https://api.example.test")

    config = get_api_config()

    assert config.static_assets_root == "custom/images"
    assert config.static_assets_url_prefix == "/assets/images"
    assert config.public_api_base_url == "https://api.example.test"
