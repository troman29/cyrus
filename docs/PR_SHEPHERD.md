# PR shepherd

**With `SHEPHERD_ENABLED=1` Cyrus stops running GitHub sessions and forwards PR events to every configured hub (unix socket or HTTP).** The legacy `@mention` and `changes_requested` session path is off while the shepherd is on; Linear, Slack and GitLab are unaffected.

Cyrus accepts `pull_request` (opened, reopened, ready_for_review, synchronize, closed), `check_suite` (completed), `pull_request_review` (submitted), `pull_request_review_comment` (created) and `issue_comment` (created, PRs only). It normalizes each event, drops what the filters reject, and sends the same request `{"op":"pr-event","v":1,"deliveryId":…,"event":…}` to **all hubs in parallel** (3 s timeout per hub): one NDJSON line for `unix:` hubs, `POST <base>/shepherd/pr-event` with `Authorization: Bearer <SHEPHERD_HUB_TOKEN>` for `http(s)` hubs. A hub answers `{"ok":true,"status":"persisted"|"duplicate","owner":"mine"|"none"}`. The reply `{"ok":false,"error":"disabled"}` (repo not enabled in that hub) counts as a normal "not mine" answer. A hub reply without `owner` counts as `mine`.

**GitHub gets 200 only if every hub, the primary included, answered ok.** An unreachable hub, a hub error, a timeout or a failed GitHub API lookup yields 503, so a redelivery retries it; hubs dedup by `deliveryId` and still answer `owner`. **GitHub does not redeliver failed deliveries on its own: an external job must call `POST /app/hook/deliveries/{id}/attempts` for them (the hub side `shepherd-redeliver` timer).** There are no retries inside the request.

If every hub answered ok and none answered `mine`, Cyrus sends `{"op":"pr-unowned","v":1,"deliveryId":…}` (`POST <base>/shepherd/pr-unowned` for http) to the **primary only** and still answers 200 when that call fails: the primary has its own 2-minute fallback.

`check_suite` and `issue_comment` payloads lack the PR title, author or head/base, so Cyrus fetches them with `GET /repos/{repo}/pulls/{n}` using the installation token forwarded with the webhook, else the local GitHub App token, else `GITHUB_TOKEN`. A `check_suite` with several PRs becomes one event per PR; their hub delivery ids are `<delivery>#<pr>` so the hub's per-delivery dedup keeps each one.

Every event produces one info line: `shepherd: delivered delivery=… repo=…#… kind=… owner=<hubName|none> hubs=<ok>/<total>` (an error line `shepherd: failed … failed=<hubs>` when a hub failed), or `shepherd: dropped reason=<reason> delivery=… repo=… kind=…` (reasons: `account_not_allowed`, `repo_not_allowed`, `not_pr`, `event_not_supported`, `bot_sender`, `author_not_allowed`, `no_pull_requests`). The transport logs ignored event types and actions the same way.

## Environment

Set these in `~/.cyrus/.env`.

- `SHEPHERD_ENABLED` — `1` turns the shepherd on.
- `SHEPHERD_HUBS` — comma-separated `name=target` list, target `unix:/path` or `http(s)://host:port`, e.g. `homelab=unix:/home/u/.claude/channels/telegram/shepherd.sock,vm=http://192.168.1.10:8787`. The entry named `primary`, else the first one, is the primary hub. Names are unique; a malformed entry stops startup.
- `SHEPHERD_HUB_TOKEN` — bearer token sent to `http(s)` hubs.
- `SHEPHERD_SOCKET` — used only when `SHEPHERD_HUBS` is unset: the single hub, named `primary`; default `$TELEGRAM_STATE_DIR/shepherd.sock`, i.e. `~/.claude/channels/telegram/shepherd.sock`.
- `SHEPHERD_ACCOUNTS` — optional comma-separated repo owners to serve (`windbit,troman29`); events from other owners are dropped with `account_not_allowed` (answer 200) before any GitHub API or hub call. Unset serves every owner.
- `SHEPHERD_AUTHORS` — comma-separated PR author logins to shepherd (case-insensitive); default `thomas5788,agentek-bot[bot]`. Comments and reviews from these logins and from any bot are dropped to avoid loops.
- `SHEPHERD_REPOS` — optional comma-separated repo globs (`windbit/*,troman29/homelab`); unset allows every repo.

The GitHub App must be subscribed to `pull_request` and `check_suite` (permissions: Pull requests, Checks: read).
