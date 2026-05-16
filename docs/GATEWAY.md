# Gateway

Butterclaw Gateway is a small loopback HTTP process for local control,
automation hooks, and compatibility probes. It follows the public shape of
OpenClaw's gateway idea, but the implementation is Butterclaw's own lightweight
runtime.

## Start

Set a local hook token before serving:

```cmd
set BUTTERCLAW_GATEWAY_TOKEN=choose-a-local-token
butterclaw gateway serve
```

Default URL:

```text
http://127.0.0.1:18789
```

Configuration flags:

```cmd
butterclaw --gateway-host 127.0.0.1 --gateway-port 19001 --gateway-token-env BUTTERCLAW_GATEWAY_TOKEN gateway serve
```

## Status

```cmd
butterclaw gateway status
butterclaw /gateway
```

HTTP endpoints:

- `GET /health`
- `GET /status`
- `GET /v1/models`

`/v1/models` returns `butterclaw`, `butterclaw/default`, and one entry per saved
agent profile.

## Hook Auth

Hooks require a token from the environment variable named by
`gatewayTokenEnv`, defaulting to `BUTTERCLAW_GATEWAY_TOKEN`.

Accepted token locations:

- `Authorization: Bearer <token>`
- `x-butterclaw-token: <token>`
- `x-openclaw-token: <token>` for compatibility with existing hook senders

Query-string tokens are rejected.

## Wake Hook

`POST /hooks/wake` queues a one-shot schedule job. A `mode` of `now` makes the
job immediately due for `butterclaw schedule run --due` or a running schedule
daemon.

```cmd
curl -X POST http://127.0.0.1:18789/hooks/wake ^
  -H "Authorization: Bearer choose-a-local-token" ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"check the build\",\"session\":\"release-work\"}"
```

Fields:

- `text` or `message`: required task text
- `mode`: `now` or `next-heartbeat`
- `session` or `sessionKey`: optional named Butterclaw session
- `name`: optional schedule name

## Agent Hook

`POST /hooks/agent` runs an isolated Butterclaw agent turn and returns the final
text result.

```cmd
curl -X POST http://127.0.0.1:18789/hooks/agent ^
  -H "Authorization: Bearer choose-a-local-token" ^
  -H "Content-Type: application/json" ^
  -d "{\"message\":\"summarize this workspace\",\"agent\":\"debugger\"}"
```

Fields:

- `message` or `text`: required task text
- `agent`, `agentId`, or `name`: optional saved agent profile
- `session` or `sessionKey`: optional named Butterclaw session

## Safety

Keep the gateway bound to loopback unless you are behind a trusted tunnel or
VPN. Hooks are operator-level automation: use a dedicated local token, keep it
out of prompts and memory, and rotate it if it appears in logs or shell history.
