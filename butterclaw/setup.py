from __future__ import annotations

import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

from butterclaw.config import ButterclawConfig, config_path, default_config_dir, save_config


InputFunc = Callable[[str], str]
OutputFunc = Callable[[str], None]


def run_setup(
    config: ButterclawConfig,
    path: Path | None = None,
    input_func: InputFunc = input,
    output_func: OutputFunc = print,
) -> int:
    """Interactive first-run setup for low-friction local installs."""

    path = path or config_path()
    align_config_dir_with_custom_path(config, path)
    output_func("Butterclaw setup")
    output_func("This creates a local config, memory file, skills folder, and starter commands.")
    output_func("")

    checks = system_checks(config)
    output_func("System check:")
    for label, ok, detail in checks:
        marker = "OK" if ok else "WARN"
        output_func(f"- {marker}: {label}{': ' + detail if detail else ''}")
    output_func("")

    provider = choose(
        input_func,
        output_func,
        "Choose provider",
        ["mock", "ollama", "openai-compatible"],
        default=config.provider,
    )
    config.provider = provider
    config.model = prompt(
        input_func,
        "Model",
        default=default_model_for(provider, config.model),
    )

    if provider == "openai-compatible":
        config.base_url = prompt(
            input_func,
            "OpenAI-compatible base URL",
            default=config.base_url or "https://api.openai.com/v1",
        )
        config.api_key_env = prompt(
            input_func,
            "API key environment variable",
            default=config.api_key_env,
        )
    elif provider == "ollama":
        config.base_url = prompt(
            input_func,
            "Ollama base URL",
            default=config.base_url or "http://localhost:11434",
        )

    config.workspace = Path(prompt(input_func, "Workspace folder", default=str(config.workspace))).resolve()
    config.daily_budget_usd = prompt_float(input_func, "Daily budget in USD", default=config.daily_budget_usd)
    config.max_steps = prompt_int(input_func, "Max agent steps per task", default=config.max_steps)
    config.shell_mode = "allow" if yes_no(input_func, "Enable shell tool?", default=False) else "deny"

    if yes_no(input_func, "Configure Telegram channel?", default=False):
        config.telegram_token_env = prompt(
            input_func,
            "Telegram token environment variable",
            default=config.telegram_token_env,
        )
        chats = prompt(
            input_func,
            "Allowed Telegram chat IDs, comma-separated",
            default=",".join(config.telegram_allowed_chats),
        )
        config.telegram_allowed_chats = [chat.strip() for chat in chats.split(",") if chat.strip()]

    create_local_files(config)
    save_config(config, path)
    output_func("")
    output_func(f"Wrote config: {path}")
    output_func(f"Skills folder: {config.skills_dir}")
    output_func(f"Memory file: {config.memory_path}")
    output_func("")
    output_func("Try it now:")
    output_func(f"  python -m butterclaw --config \"{path}\" \"list the files in this workspace\"")
    if config.provider == "ollama":
        output_func("")
        output_func("For Telegram with Ollama:")
        output_func(f"  $env:{config.telegram_token_env} = \"123456:your-token\"")
        output_func(
            f"  python -m butterclaw --config \"{path}\" --telegram-poll --telegram-allowed-chat YOUR_CHAT_ID"
        )
    elif config.provider == "openai-compatible":
        output_func("")
        output_func("Before using the API provider:")
        output_func(f"  $env:{config.api_key_env} = \"your-api-key\"")
    return 0


def align_config_dir_with_custom_path(config: ButterclawConfig, path: Path) -> None:
    default_dir = default_config_dir().resolve()
    requested_path = path.resolve()
    if requested_path == config_path().resolve() or config.config_dir != default_dir:
        return

    old_skills = default_dir / "skills"
    old_memory = default_dir / "memory.jsonl"
    old_telegram_state = default_dir / "telegram-state.json"

    config.config_dir = requested_path.parent
    if config.skills_dir == old_skills:
        config.skills_dir = config.config_dir / "skills"
    if config.memory_path == old_memory:
        config.memory_path = config.config_dir / "memory.jsonl"
    if config.telegram_state_path == old_telegram_state:
        config.telegram_state_path = config.config_dir / "telegram-state.json"


def system_checks(config: ButterclawConfig) -> list[tuple[str, bool, str]]:
    checks: list[tuple[str, bool, str]] = [
        (
            "Python",
            sys.version_info >= (3, 10),
            f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        ),
        ("Git", shutil.which("git") is not None, shutil.which("git") or "not found"),
    ]
    ollama_url = config.base_url or "http://localhost:11434"
    checks.append(("Ollama", ollama_reachable(ollama_url), ollama_url))
    return checks


def ollama_reachable(base_url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{base_url.rstrip('/')}/api/tags", timeout=2) as response:
            return 200 <= response.status < 300
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def create_local_files(config: ButterclawConfig) -> None:
    config.config_dir.mkdir(parents=True, exist_ok=True)
    config.workspace.mkdir(parents=True, exist_ok=True)
    if config.skills_dir:
        config.skills_dir.mkdir(parents=True, exist_ok=True)
        starter = config.skills_dir / "starter.md"
        if not starter.exists():
            starter.write_text(
                "# Starter\n\n"
                "Use this skill for everyday local assistant work. Prefer small, reversible steps. "
                "Ask before destructive file changes, purchases, messages, or shell commands with broad impact.\n",
                encoding="utf-8",
            )
    if config.memory_path:
        config.memory_path.parent.mkdir(parents=True, exist_ok=True)
        config.memory_path.touch(exist_ok=True)
    if config.telegram_state_path:
        config.telegram_state_path.parent.mkdir(parents=True, exist_ok=True)


def default_model_for(provider: str, current: str) -> str:
    if provider == "mock":
        return "mock-cheap"
    if provider == "ollama":
        return current if current and current != "mock-cheap" else "llama3.2:3b"
    return current if current and current != "mock-cheap" else "cheap-model"


def choose(
    input_func: InputFunc,
    output_func: OutputFunc,
    label: str,
    options: list[str],
    default: str,
) -> str:
    default = default if default in options else options[0]
    output_func(f"{label}:")
    for index, option in enumerate(options, start=1):
        suffix = " (default)" if option == default else ""
        output_func(f"  {index}. {option}{suffix}")
    while True:
        value = input_func(f"{label} [{default}]: ").strip()
        if not value:
            return default
        if value in options:
            return value
        if value.isdigit() and 1 <= int(value) <= len(options):
            return options[int(value) - 1]
        output_func(f"Please choose one of: {', '.join(options)}")


def prompt(input_func: InputFunc, label: str, default: str) -> str:
    value = input_func(f"{label} [{default}]: ").strip()
    return value or default


def prompt_float(input_func: InputFunc, label: str, default: float) -> float:
    while True:
        value = input_func(f"{label} [{default}]: ").strip()
        if not value:
            return default
        try:
            return float(value)
        except ValueError:
            print("Please enter a number.")


def prompt_int(input_func: InputFunc, label: str, default: int) -> int:
    while True:
        value = input_func(f"{label} [{default}]: ").strip()
        if not value:
            return default
        try:
            return int(value)
        except ValueError:
            print("Please enter a whole number.")


def yes_no(input_func: InputFunc, label: str, default: bool) -> bool:
    suffix = "Y/n" if default else "y/N"
    while True:
        value = input_func(f"{label} [{suffix}]: ").strip().lower()
        if not value:
            return default
        if value in {"y", "yes"}:
            return True
        if value in {"n", "no"}:
            return False
        print("Please answer yes or no.")
