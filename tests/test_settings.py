import json
import os
import stat
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import config_store
import server


class SettingsFixture(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / ".env"
        self.environment = patch.dict(os.environ, {
            **config_store.DEFAULTS,
            "NVIDIA_API_KEY": "saved-nvidia-secret",
            "MEM0_API_KEY": "saved-mem0-secret",
            "CLOUDFLARE_API_TOKEN": "saved-cf-secret",
        }, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.env_file = patch.object(config_store, "ENV_FILE", self.path)
        self.env_file.start()
        self.addCleanup(self.env_file.stop)
        self.path.write_text('# keep this comment\nNVIDIA_API_KEY=saved-nvidia-secret\nCUSTOM_OPTION=untouched\nWAKE_PHRASE=old\nWAKE_PHRASE=duplicate\n', encoding="utf-8")

    def save(self, values, clear=None):
        return config_store.save_settings({"values": values, "clear_secrets": clear or []}, server.MODEL_IDS)


class SettingsTests(SettingsFixture):
    def test_public_settings_never_returns_credentials(self):
        response = config_store.public_settings()
        for key in config_store.SECRET_KEYS:
            self.assertNotIn(key, response["values"])
            self.assertTrue(response["secrets"][key])
            self.assertNotIn(os.environ[key], json.dumps(response))

    def test_wake_phrase_is_persisted_and_applied_immediately(self):
        self.save({"WAKE_PHRASE": "你好小童", "NVIDIA_API_KEY": ""})
        content = self.path.read_text()
        self.assertIn("# keep this comment", content)
        self.assertIn("CUSTOM_OPTION=untouched", content)
        self.assertIn("NVIDIA_API_KEY=saved-nvidia-secret", content)
        self.assertEqual(content.count("WAKE_PHRASE="), 1)
        self.assertEqual(config_store.setting("WAKE_PHRASE"), "你好小童")
        self.assertEqual(config_store.setting("NVIDIA_API_KEY"), "saved-nvidia-secret")
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_replace_and_explicitly_clear_secrets(self):
        response = self.save({"NVIDIA_API_KEY": "replacement-secret"}, ["MEM0_API_KEY"])
        self.assertEqual(config_store.setting("NVIDIA_API_KEY"), "replacement-secret")
        self.assertEqual(config_store.setting("MEM0_API_KEY"), "")
        self.assertFalse(response["secrets"]["MEM0_API_KEY"])
        self.assertNotIn("replacement-secret", json.dumps(response))

    def test_quoted_values_round_trip_without_shell_interpretation(self):
        value = 'secret-"quoted"-\\-#-$HOME-$(literal)'
        self.save({"NVIDIA_API_KEY": value, "WAKE_PHRASE": "你好，迦童"})
        os.environ.pop("NVIDIA_API_KEY")
        os.environ.pop("WAKE_PHRASE")
        config_store.load_dotenv()
        self.assertEqual(config_store.setting("NVIDIA_API_KEY"), value)
        self.assertEqual(config_store.setting("WAKE_PHRASE"), "你好，迦童")

    def test_invalid_updates_change_neither_file_nor_live_values(self):
        before = self.path.read_bytes()
        cases = [
            {"WAKE_PHRASE": ""}, {"WAKE_PHRASE": "！ ！"}, {"WAKE_PHRASE": "a"},
            {"PORT": "0"}, {"PORT": "65536"}, {"PORT": "1.5"},
            {"NVIDIA_REASONING_EFFORT": "extreme"}, {"NVIDIA_DEFAULT_MODEL": "unsupported"},
            {"NVIDIA_BASE_URL": "file:///tmp/key"}, {"NVIDIA_BASE_URL": "https://user:password@example.com"},
            {"NVIDIA_API_KEY": "token\nINJECTED=true"}, {"PATH": "unwanted"},
        ]
        for values in cases:
            with self.subTest(keys=list(values)):
                with self.assertRaises(ValueError):
                    self.save(values)
                self.assertEqual(self.path.read_bytes(), before)
                self.assertEqual(config_store.setting("NVIDIA_API_KEY"), "saved-nvidia-secret")

    def test_failed_atomic_replace_preserves_file_and_environment(self):
        before = self.path.read_bytes()
        with patch.object(config_store.os, "replace", side_effect=OSError("test write failure")):
            with self.assertRaises(OSError):
                self.save({"WAKE_PHRASE": "新的关键词"})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(config_store.setting("WAKE_PHRASE"), "你好迦童")
        self.assertEqual(list(self.path.parent.glob(".env.save-*")), [])

    def test_first_save_can_create_env_file(self):
        self.path.unlink()
        self.save({"WAKE_PHRASE": "你好迦童"})
        self.assertTrue(self.path.is_file())

    def test_custom_wake_reply_round_trips_to_env_and_public_settings(self):
        response = self.save({"WAKE_PHRASE": "童童大王", "WAKE_REPLY_TEXT": "你好，主人您有什么吩咐"})
        self.assertEqual(response["values"]["WAKE_REPLY_TEXT"], "你好，主人您有什么吩咐")
        os.environ.pop("WAKE_REPLY_TEXT")
        config_store.load_dotenv()
        self.assertEqual(config_store.setting("WAKE_REPLY_TEXT"), "你好，主人您有什么吩咐")

    def test_invalid_wake_replies_cannot_overwrite_env(self):
        before = self.path.read_bytes()
        for text in ("", "！", "你好\n主人", "好" * 201):
            with self.subTest(length=len(text)):
                with self.assertRaises(ValueError):
                    self.save({"WAKE_REPLY_TEXT": text})
                self.assertEqual(self.path.read_bytes(), before)

    def test_shell_variables_still_override_dotenv_on_startup(self):
        os.environ["WAKE_PHRASE"] = "shell value"
        config_store.load_dotenv()
        self.assertEqual(config_store.setting("WAKE_PHRASE"), "shell value")


class SettingsAPITests(SettingsFixture):
    def setUp(self):
        super().setUp()

        class QuietHandler(server.AppHandler):
            def log_message(self, *_args):
                pass

        self.http = server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.http.server_port)
        self.addCleanup(self.close_server)

    def close_server(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()

    def request(self, path="/api/settings", payload=None, headers=None):
        request = urllib.request.Request(self.base + path, headers=headers or {})
        if payload is not None:
            request.data = json.dumps(payload).encode()
            request.add_header("Content-Type", "application/json")
        try:
            response = urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read()), response.headers

    def test_get_masks_secrets_and_sets_no_store(self):
        status, payload, headers = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertTrue(payload["csrf_token"])
        self.assertIn("models", payload)
        self.assertNotIn("saved-nvidia-secret", json.dumps(payload))

    def test_save_requires_token_and_blocks_cross_origin_requests(self):
        before = self.path.read_bytes()
        status, _, _ = self.request(payload={"values": {"WAKE_PHRASE": "新关键词"}})
        self.assertEqual(status, 403)
        status, _, _ = self.request(payload={"values": {"WAKE_PHRASE": "新关键词"}}, headers={
            "X-Settings-Token": config_store.SETTINGS_TOKEN, "Origin": "https://other.example",
        })
        self.assertEqual(status, 403)
        status, _, _ = self.request(headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)
        self.assertEqual(self.path.read_bytes(), before)

    def test_save_updates_public_wake_config_and_reports_port_restart(self):
        headers = {"X-Settings-Token": config_store.SETTINGS_TOKEN, "Origin": self.base}
        status, result, _ = self.request(payload={"values": {
            "WAKE_PHRASE": "童童大王", "WAKE_REPLY_TEXT": "主人，我在。", "PORT": str(self.http.server_port),
        }}, headers=headers)
        self.assertEqual(status, 200)
        self.assertFalse(result["restart_required"])
        self.assertNotIn("saved-nvidia-secret", json.dumps(result))
        _, config, _ = self.request("/api/config")
        self.assertEqual(config["wake_phrase"], "童童大王")
        self.assertEqual(config["wake_reply_text"], "主人，我在。")
        self.assertEqual(config["tts_voice"], "zh-CN-XiaoxiaoNeural")
        status, result, _ = self.request(payload={"values": {"PORT": "5050"}}, headers=headers)
        self.assertEqual(status, 200)
        self.assertTrue(result["restart_required"])

    def test_validation_errors_are_400_and_env_file_is_not_served(self):
        status, _, _ = self.request(payload={"values": {"WAKE_PHRASE": ""}}, headers={"X-Settings-Token": config_store.SETTINGS_TOKEN})
        self.assertEqual(status, 400)
        status, _, _ = self.request("/.env")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
