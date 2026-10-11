"""Tests for scripts/generate-installation-token.py."""

import json
import os
import sys
import time
from http.client import HTTPResponse
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add scripts dir to path so we can import the module
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "scripts"))

# Generate a test RSA key pair at import time
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization

_TEST_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
TEST_PRIVATE_KEY_PEM = _TEST_PRIVATE_KEY.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
).decode()

import importlib

# Import the script as a module
_script_path = Path(__file__).parent.parent.parent / "scripts" / "generate-installation-token.py"
spec = importlib.util.spec_from_file_location("generate_installation_token", _script_path)
gen_token = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen_token)


class TestCreateJwt:
    def test_creates_valid_jwt(self):
        import jwt as pyjwt

        token = gen_token.create_jwt("12345", TEST_PRIVATE_KEY_PEM)
        decoded = pyjwt.decode(
            token,
            _TEST_PRIVATE_KEY.public_key(),
            algorithms=["RS256"],
            options={"verify_exp": False},
        )
        assert decoded["iss"] == "12345"
        assert decoded["iat"] <= int(time.time())
        assert decoded["exp"] > int(time.time())

    def test_rejects_invalid_key(self):
        with pytest.raises((ValueError, Exception)):
            gen_token.create_jwt("12345", "not-a-real-key")


class TestFindInstallation:
    def _mock_response(self, data, headers=None):
        resp = MagicMock(spec=HTTPResponse)
        resp.read.return_value = json.dumps(data).encode()
        resp.headers = MagicMock()
        resp.headers.get.return_value = headers.get("Link", "") if headers else ""
        resp.__enter__ = MagicMock(return_value=resp)
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    @patch("urllib.request.urlopen")
    def test_finds_installation_on_first_page(self, mock_urlopen):
        installations = [
            {"id": 100, "account": {"login": "other-org"}},
            {"id": 200, "account": {"login": "trycycloid"}},
        ]
        mock_urlopen.return_value = self._mock_response(installations)

        result = gen_token.find_installation("fake-jwt")
        assert result == 200

    @patch("urllib.request.urlopen")
    def test_finds_installation_on_second_page(self, mock_urlopen):
        page1 = [{"id": 100, "account": {"login": "other-org"}}]
        page2 = [{"id": 200, "account": {"login": "trycycloid"}}]

        resp1 = self._mock_response(
            page1, headers={"Link": '<https://api.github.com/app/installations?page=2>; rel="next"'}
        )
        resp2 = self._mock_response(page2)
        mock_urlopen.side_effect = [resp1, resp2]

        result = gen_token.find_installation("fake-jwt")
        assert result == 200

    @patch("urllib.request.urlopen")
    def test_exits_when_not_found(self, mock_urlopen):
        installations = [{"id": 100, "account": {"login": "other-org"}}]
        mock_urlopen.return_value = self._mock_response(installations)

        with pytest.raises(SystemExit) as exc_info:
            gen_token.find_installation("fake-jwt")
        assert exc_info.value.code == 1

    @patch("urllib.request.urlopen")
    def test_exits_on_api_error(self, mock_urlopen):
        from urllib.error import HTTPError

        mock_urlopen.side_effect = HTTPError(
            url="https://api.github.com/app/installations",
            code=401,
            msg="Unauthorized",
            hdrs={},
            fp=BytesIO(b"Bad credentials"),
        )

        with pytest.raises(SystemExit) as exc_info:
            gen_token.find_installation("fake-jwt")
        assert exc_info.value.code == 1


class TestCreateInstallationToken:
    @patch("urllib.request.urlopen")
    def test_returns_token(self, mock_urlopen):
        resp = MagicMock(spec=HTTPResponse)
        resp.read.return_value = json.dumps({"token": "ghs_abc123"}).encode()
        resp.__enter__ = MagicMock(return_value=resp)
        resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = resp

        result = gen_token.create_installation_token("fake-jwt", 200)
        assert result == "ghs_abc123"

        # Verify the request body includes scoped repositories
        call_args = mock_urlopen.call_args[0][0]
        body = json.loads(call_args.data)
        assert body["repositories"] == ["cycloid"]

    @patch("urllib.request.urlopen")
    def test_exits_on_api_error(self, mock_urlopen):
        from urllib.error import HTTPError

        mock_urlopen.side_effect = HTTPError(
            url="https://api.github.com/test",
            code=403,
            msg="Forbidden",
            hdrs={},
            fp=BytesIO(b"Rate limited"),
        )

        with pytest.raises(SystemExit) as exc_info:
            gen_token.create_installation_token("fake-jwt", 200)
        assert exc_info.value.code == 1


class TestMain:
    @patch.dict(os.environ, {}, clear=True)
    def test_exits_without_app_id(self):
        with pytest.raises(SystemExit) as exc_info:
            gen_token.main()
        assert exc_info.value.code == 1

    @patch.dict(os.environ, {"GH_APP_ID": "123"}, clear=True)
    def test_exits_without_private_key(self):
        with pytest.raises(SystemExit) as exc_info:
            gen_token.main()
        assert exc_info.value.code == 1

    @patch.dict(
        os.environ,
        {"GH_APP_ID": "123", "GH_APP_PRIVATE_KEY": TEST_PRIVATE_KEY_PEM},
        clear=True,
    )
    @patch.object(gen_token, "find_installation", return_value=200)
    @patch.object(gen_token, "create_installation_token", return_value="ghs_test_token")
    def test_full_flow(self, mock_create, mock_find, capsys):
        gen_token.main()
        captured = capsys.readouterr()
        assert captured.out.strip() == "ghs_test_token"
        mock_find.assert_called_once()
        # create_installation_token is called with (jwt_string, installation_id)
        args = mock_create.call_args[0]
        assert isinstance(args[0], str)  # JWT token
        assert args[1] == 200  # installation ID

    @patch.dict(
        os.environ,
        {"GH_APP_ID": "123", "GH_APP_PRIVATE_KEY": "not\\na\\nreal\\nkey"},
        clear=True,
    )
    def test_handles_escaped_newlines(self):
        """Verify that literal \\n in the env var is converted to real newlines."""
        with patch.object(gen_token, "create_jwt", side_effect=ValueError("bad key")) as mock_jwt:
            with pytest.raises(SystemExit):
                gen_token.main()
            # The key passed to create_jwt should have real newlines, not escaped
            called_key = mock_jwt.call_args[0][1]
            assert "\\n" not in called_key
            assert "\n" in called_key
