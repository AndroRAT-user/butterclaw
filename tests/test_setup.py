from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from butterclaw.cli import is_setup_task
from butterclaw.config import ButterclawConfig
from butterclaw.setup import run_setup


class SetupTests(unittest.TestCase):
    def test_setup_alias_detection(self) -> None:
        self.assertTrue(is_setup_task(["setup"]))
        self.assertTrue(is_setup_task(["onboard"]))
        self.assertFalse(is_setup_task(["setup", "my", "project"]))

    def test_run_setup_writes_config_and_starter_skill(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = ButterclawConfig(
                workspace=root / "workspace",
                config_dir=root / "config",
                base_url="http://127.0.0.1:1",
                memory_path=root / "config" / "memory.jsonl",
                skills_dir=root / "config" / "skills",
                telegram_state_path=root / "config" / "telegram-state.json",
            )
            answers = iter(
                [
                    "",  # provider default
                    "",  # model default
                    "",  # workspace default
                    "",  # budget default
                    "",  # max steps default
                    "",  # shell default no
                    "",  # telegram default no
                ]
            )
            lines: list[str] = []

            result = run_setup(
                config,
                path=root / "config.json",
                input_func=lambda _: next(answers),
                output_func=lines.append,
            )

            self.assertEqual(result, 0)
            self.assertTrue((root / "config.json").exists())
            self.assertTrue((root / "config" / "memory.jsonl").exists())
            self.assertTrue((root / "config" / "skills" / "starter.md").exists())
            self.assertIn("Wrote config", "\n".join(lines))

    def test_setup_custom_config_keeps_files_near_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = ButterclawConfig(base_url="http://127.0.0.1:1")
            answers = iter(["", "", "", "", "", "", ""])

            run_setup(
                config,
                path=root / "custom" / "butterclaw.json",
                input_func=lambda _: next(answers),
                output_func=lambda _: None,
            )

            self.assertTrue((root / "custom" / "skills" / "starter.md").exists())
            self.assertTrue((root / "custom" / "memory.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
