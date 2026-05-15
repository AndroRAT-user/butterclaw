# First-Run Setup

Butterclaw includes a small onboarding command:

```powershell
python -m butterclaw setup
```

You can also run:

```powershell
python -m butterclaw --setup
```

The setup flow:

- checks Python, Git, and whether Ollama is reachable
- asks which provider to use: `mock`, `ollama`, or `openai-compatible`
- asks for model, workspace, budget, and step limits
- keeps shell access disabled unless you explicitly enable it
- optionally configures Telegram chat access
- creates the config file, memory file, and skills folder
- writes a tiny starter skill
- prints the command to run next

## Suggested Budget Setup

For a low-end PC with no API bill, choose:

- provider: `ollama`
- model: `llama3.2:3b` or another small local model
- shell tool: `no` until you need it

For a cheap hosted API, choose:

- provider: `openai-compatible`
- model: your provider's budget model
- daily budget: start with `0.25`

Butterclaw stores the API key environment variable name in config, not the
secret itself.

## Telegram During Setup

If you choose Telegram setup, Butterclaw stores allowed chat IDs and the token
environment variable name. Set the token before running Telegram:

```powershell
$env:TELEGRAM_BOT_TOKEN = "123456:your-token"
python -m butterclaw --telegram-poll
```

