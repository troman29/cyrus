# PR shepherd

**With `SHEPHERD_ENABLED=1` Cyrus stops running GitHub sessions and forwards PR events to a hub over a unix socket.** The legacy `@mention` and `changes_requested` session path is off while the shepherd is on; Linear, Slack and GitLab are unaffected.

Cyrus accepts `pull_request` (opened, reopened, ready_for_review, synchronize, closed), `check_suite` (completed), `pull_request_review` (submitted), `pull_request_review_comment` (created) and `issue_comment` (created, PRs only). It normalizes each event, drops what the filters reject, and sends one NDJSON line `{"op":"pr-event","v":1,"deliveryId":…,"event":…}` to `shepherd.sock`. **GitHub gets 200 only after the hub answers `persisted` or `duplicate`**; an unreachable hub, a hub error, a 3 s timeout or a failed GitHub API lookup yields 503, so a redelivery retries it. **GitHub does not redeliver failed deliveries on its own: an external job must call `POST /app/hook/deliveries/{id}/attempts` for them (the hub side `shepherd-redeliver` timer).** There are no retries inside the request.

`check_suite` and `issue_comment` payloads lack the PR title, author or head/base, so Cyrus fetches them with `GET /repos/{repo}/pulls/{n}` using the installation token forwarded with the webhook, else the local GitHub App token, else `GITHUB_TOKEN`. A `check_suite` with several PRs becomes one event per PR; their hub delivery ids are `<delivery>#<pr>` so the hub's per-delivery dedup keeps each one.

Every event produces one info line: `shepherd: forwarded|duplicate|failed delivery=… repo=…#… kind=…`, or `shepherd: dropped reason=<reason> delivery=… repo=… kind=…` (reasons: `repo_not_allowed`, `not_pr`, `event_not_supported`, `bot_sender`, `author_not_allowed`, `no_pull_requests`). The transport logs ignored event types and actions the same way.

## Environment

Set these in `~/.cyrus/.env`.

- `SHEPHERD_ENABLED` — `1` turns the shepherd on.
- `SHEPHERD_SOCKET` — hub socket; default `$TELEGRAM_STATE_DIR/shepherd.sock`, i.e. `~/.claude/channels/telegram/shepherd.sock`.
- `SHEPHERD_AUTHORS` — comma-separated PR author logins to shepherd (case-insensitive); default `thomas5788,agentek-bot[bot]`. Comments and reviews from these logins and from any bot are dropped to avoid loops.
- `SHEPHERD_REPOS` — optional comma-separated repo globs (`windbit/*,troman29/homelab`); unset allows every repo.

The GitHub App must be subscribed to `pull_request` and `check_suite` (permissions: Pull requests, Checks: read).
