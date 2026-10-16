"""Validated, atomic storage for the application's editable .env settings."""

from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
import threading
import urllib.parse
from pathlib import Path
from typing import Any

ENV_FILE = Path(__file__).resolve().with_name(".env")
CONFIG_LOCK = threading.RLock()
SETTINGS_TOKEN = secrets.token_urlsafe(32)
SECRET_KEYS = frozenset({"NVIDIA_API_KEY", "MEM0_API_KEY", "CLOUDFLARE_API_TOKEN"})
DEFAULTS = {
    "NVIDIA_API_KEY": "",
    "MEM0_API_KEY": "",
    "CLOUDFLARE_ACCOUNT_ID": "",
    "CLOUDFLARE_API_TOKEN": "",
    "NVIDIA_BASE_URL": "https://integrate.api.nvidia.com/v1",
    "NVIDIA_DEFAULT_MODEL": "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "NVIDIA_REASONING_EFFORT": "low",
    "MEM0_USER_ID": "personal-assistant",
    "PORT": "5001",
    "TTS_VOICE": "zh-CN-XiaoxiaoNeural",
    "WAKE_PHRASE": "你好迦童",
    "WAKE_REPLY_TEXT": "你好，主人您有什么吩咐",
}
ENV_ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")


def load_dotenv(path: Path | None = None) -> None:
    """Load local settings without replacing explicit shell variables."""
    path = path or ENV_FILE
    if not path.exists():
        return
    with CONFIG_LOCK:
        for line in path.read_text(encoding="utf-8").splitlines():
            match = ENV_ASSIGNMENT.match(line)
            if not match:
                continue
            value = line[match.end():].strip()
            if value.startswith('"'):
                try:
                    decoded = json.loads(value)
                    if isinstance(decoded, str):
                        value = decoded
                except ValueError:
                    if len(value) >= 2 and value[-1] == '"':
                        value = value[1:-1]
            elif len(value) >= 2 and value[0] == value[-1] == "'":
                value = value[1:-1]
            os.environ.setdefault(match[1], value)


def setting(key: str, default: str = "") -> str:
    with CONFIG_LOCK:
        return os.environ.get(key, default).strip()


def public_settings() -> dict[str, Any]:
    """Return editable values and presence flags, never stored credentials."""
    with CONFIG_LOCK:
        return {
            "values": {key: setting(key, default) for key, default in DEFAULTS.items() if key not in SECRET_KEYS},
            "secrets": {key: bool(setting(key)) for key in SECRET_KEYS},
        }


def validate_updates(body: dict[str, Any], model_ids: set[str]) -> dict[str, str]:
    values = body.get("values", {})
    clear = body.get("clear_secrets", [])
    if not isinstance(values, dict) or not isinstance(clear, list):
        raise ValueError("设置格式无效，请重新打开设置后重试。")
    if set(body) - {"values", "clear_secrets"} or set(values) - DEFAULTS.keys():
        raise ValueError("包含不支持的配置项。")
    if any(not isinstance(key, str) or key not in SECRET_KEYS for key in clear):
        raise ValueError("只能明确清除 API 密钥。")
    updates = {}
    for key, value in values.items():
        if not isinstance(value, str) or len(value) > 4096 or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError(f"{key} 的内容无效，不能包含换行或控制字符。")
        value = value.strip()
        if key in SECRET_KEYS and not value:
            continue  # Empty password inputs keep the saved credential.
        updates[key] = value
    for key in clear:
        if updates.get(key):
            raise ValueError(f"{key} 不能同时替换和清除。")
        updates[key] = ""

    for key in ("NVIDIA_BASE_URL", "NVIDIA_DEFAULT_MODEL", "NVIDIA_REASONING_EFFORT", "MEM0_USER_ID", "PORT", "TTS_VOICE", "WAKE_PHRASE", "WAKE_REPLY_TEXT"):
        if key in updates and not updates[key]:
            raise ValueError(f"{key} 不能为空。")
    if "PORT" in updates:
        if not updates["PORT"].isascii() or not updates["PORT"].isdigit() or not 1 <= int(updates["PORT"]) <= 65535:
            raise ValueError("端口必须是 1 到 65535 之间的整数。")
        updates["PORT"] = str(int(updates["PORT"]))
    if "NVIDIA_REASONING_EFFORT" in updates and updates["NVIDIA_REASONING_EFFORT"] not in {"none", "low", "high"}:
        raise ValueError("推理强度必须是 none、low 或 high。")
    if "NVIDIA_DEFAULT_MODEL" in updates and updates["NVIDIA_DEFAULT_MODEL"] not in model_ids:
        raise ValueError("请选择列表中支持的 NVIDIA 模型。")
    if "NVIDIA_BASE_URL" in updates:
        try:
            url = urllib.parse.urlsplit(updates["NVIDIA_BASE_URL"])
            valid = url.scheme in {"http", "https"} and url.hostname and not (url.username or url.password or url.query or url.fragment)
            url.port  # Validate the optional port too.
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("NVIDIA API 地址必须是有效的 HTTP 或 HTTPS 地址，且不能包含账号、密码或查询参数。")
    if "WAKE_PHRASE" in updates:
        phrase = updates["WAKE_PHRASE"]
        if not 2 <= len(phrase) <= 40 or sum(char.isalnum() for char in phrase) < 2:
            raise ValueError("唤醒关键词需包含至少 2 个文字或字母，最多 40 个字符。")
    if "WAKE_REPLY_TEXT" in updates and (len(updates["WAKE_REPLY_TEXT"]) > 200 or not any(char.isalnum() for char in updates["WAKE_REPLY_TEXT"])):
        raise ValueError("唤醒应答需包含可朗读的文字，最多 200 个字符。")
    return updates


def save_settings(body: dict[str, Any], model_ids: set[str], path: Path | None = None) -> dict[str, Any]:
    updates = validate_updates(body, model_ids)
    path = path or ENV_FILE
    with CONFIG_LOCK:
        original = path.read_text(encoding="utf-8") if path.exists() else ""
        lines = []
        written = set()
        for line in original.splitlines():
            match = ENV_ASSIGNMENT.match(line)
            key = match[1] if match else None
            if key in updates:
                if key not in written:
                    lines.append(key + "=" + json.dumps(updates[key], ensure_ascii=False))
                    written.add(key)
            else:
                lines.append(line)
        for key, value in updates.items():
            if key not in written:
                lines.append(key + "=" + json.dumps(value, ensure_ascii=False))
        # Replace in the same directory so a failed write cannot truncate .env.
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=".env.save-", delete=False) as output:
                temporary = Path(output.name)
                os.chmod(temporary, 0o600)
                output.write("\n".join(lines) + "\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        os.environ.update(updates)
        return public_settings()
