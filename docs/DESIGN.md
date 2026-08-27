# herdr-wsl-notify design document

Implementation plan for a herdr plugin that shows a Windows desktop toast when
an agent (Claude Code, etc.) running under WSL2 finishes a session (`done`) or
stops waiting for approval (`blocked`).

- Research date: 2026-08-27
- Target herdr version: 0.8.2 (installed in this environment)
- Verified on: WSL2 Ubuntu / Windows PowerShell 5.1.26100 / Node.js 24

---

## 1. The herdr plugin mechanism (findings from the official docs)

Sources: [Plugins](https://herdr.dev/docs/plugins/), [Socket API](https://herdr.dev/docs/socket-api/), [Agents](https://herdr.dev/docs/agents/) (raw docs for the v0.8.2 tag, checked via llms.txt)

### 1.1 Basic plugin structure

- A plugin is just a directory containing a `herdr-plugin.toml` manifest plus executable commands. Any language works (Bash / Node / Rust / PowerShell / anything launchable via argv).
- There is no dedicated SDK; **the entire herdr CLI is the plugin API**. Plugins can call back into herdr via `HERDR_BIN_PATH`.
- Entry points declarable in the manifest:
  - `[[build]]` — build command run on GitHub install
  - `[[startup]]` — one-shot init hook after session restore
  - `[[actions]]` — actions launched manually or via keybindings
  - `[[events]]` — **hooks run whenever herdr fires an event (the core of this plugin)**
  - `[[panes]]` / `[[link_handlers]]` — not needed here
- Required fields: `id` / `name` / `version` / `min_herdr_version`. Declare supported OSes with e.g. `platforms = ["linux"]` (omitting it produces a warning at link time).
- `command` is an argv array and is **launched without a shell** (no shell expansion).

### 1.2 Event hooks

```toml
[[events]]
on = "pane.agent_status_changed"
command = ["node", "notify.mjs"]
```

- For enabled installed plugins, herdr launches the command every time the event fires.
- Hook commands receive the following environment variables:
  - `HERDR_PLUGIN_EVENT` — event name
  - `HERDR_PLUGIN_EVENT_JSON` — event payload (`data.agent_status`, `data.display_agent`, `data.workspace_id`, etc.)
  - `HERDR_PLUGIN_CONTEXT_JSON` — invocation context: workspace / tab / pane / agent, etc.
  - `HERDR_PLUGIN_CONFIG_DIR` — user-editable config location (`.env`, etc.)
  - `HERDR_PLUGIN_STATE_DIR` — plugin-local state location
  - `HERDR_BIN_PATH` / `HERDR_SOCKET_PATH` — for calling back into herdr
- Event names are validated at link time (unknown names pass with a warning). Check via `warnings` in `plugin.list`.
- **There is no event filtering on the hook side.** `pane.agent_status_changed` fires for every transition (including `working` → `idle`), so filtering down to notification-worthy statuses must happen in the script.

### 1.3 Event and agent statuses used

- Event used: **`pane.agent_status_changed`** (one of the pane events; others include `pane.created` / `pane.exited`)
- Possible agent status values (confirmed via `herdr agent wait --help`): **`idle` / `working` / `blocked` / `done` / `unknown`**
  - `done` = the agent finished its work (unviewed completed state)
  - `blocked` = waiting for approval / a question / a permission
  - Claude Code is detected via "screen manifest" (status inferred from screen snapshots). Installing `herdr integration install claude` improves session identification.
- The requirement "when the session is finished or stopped" = **notify on `done` and `blocked`** (`idle` optionally addable).

### 1.4 Official example (used as the template)

**`agent-telegram-notify`** from the official cookbook
[`ogulcancelik/herdr-plugin-examples`](https://github.com/ogulcancelik/herdr-plugin-examples)
is almost exactly this use case:

- `pane.agent_status_changed` hook → Node script → send notification only for `["done", "blocked"]`
- Config loaded from `HERDR_PLUGIN_CONFIG_DIR/.env` (with a `.env` at the plugin root as a development-time fallback)
- Toggle action flipping an `HERDR_PLUGIN_STATE_DIR/enabled` file on/off (keybindable)
- Zero npm dependencies, Node 18+ only

Following this structure as-is and swapping the delivery target from Telegram
to Windows toasts is the shortest path and stays on the officially recommended
pattern.

### 1.5 Development workflow

```sh
herdr plugin link .                          # local development uses link (build does not run)
herdr plugin list                            # check warnings
herdr plugin action invoke <id>.test         # manual test
herdr plugin log list --plugin <id>          # hook execution logs / stderr
herdr plugin config-dir <id>                 # print the config directory path
```

- link/install can be registered even while the server is stopped, and applies user-globally across all sessions.
- To publish, add the GitHub topic `herdr-plugin` to the repository and it is listed on the marketplace automatically.

---

## 2. WSL → Windows desktop notifications (research and verification)

Sources: [Zenn article (yakborg: Windows toast notifications from Claude Code on WSL)](https://zenn.dev/yakborg/articles/wsl-claude-code-windows-toast) + measurements in this environment

### 2.1 Key points from the article

- Basic path: `WSL → powershell.exe (Windows interop) → BurntToast module → toast`. Execution time 0.5–0.6 s.
- **Pitfall 1: BurntToast must be installed into Windows PowerShell 5.1** (its module path is separate from pwsh 7's).
- **Pitfall 2: PSModulePath pollution.** `powershell.exe` launched from WSL inherits the parent process's `PSModulePath` and **fails silently** when the module cannot be found. The workaround is to explicitly prepend `Documents\WindowsPowerShell\Modules` to `$env:PSModulePath`.
- Duplicate notifications can be made to replace instead of stack via `Submit-BTNotification -UniqueIdentifier` (Tag).
- Advanced: registering a `claude-toast:` custom URI protocol in the registry lets a toast click bring the terminal to the foreground (an empty Alt keystroke is needed to bypass the foreground lock).

### 2.2 Comparison of notification mechanisms

| Approach | Dependency | Notes |
| --- | --- | --- |
| **Direct WinRT API call (chosen)** | None (stock PowerShell 5.1) | Call `ToastNotificationManager` directly from powershell.exe. No module = no PSModulePath issue, no Install-Module. Replacement via Tag/Group also works |
| BurntToast | Install-Module into PS 5.1 | Rich content (buttons, images, sound) is easy, but requires per-user setup + the PSModulePath pitfall |
| wsl-notify-send (Go binary) | Binary distribution/install | notify-send compatible and convenient, but asks users to install an external binary |
| `msg.exe` etc. | None | A dialog, not a toast. Rejected |

### 2.3 Measurements in this environment

- `powershell.exe` exists at `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` and is launchable from WSL. `wslpath` is available.
- **BurntToast is not installed** (not found even after fixing PSModulePath) → supports the zero-dependency direct-WinRT approach.
- The direct WinRT approach successfully showed a toast. **Execution time 0.37 s** (faster than the article's 0.5–0.6 s with BurntToast). Verification code:

```powershell
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>herdr</text><text>Claude is done</text></binding></visual></toast>')
$toast = New-Object Windows.UI.Notifications.ToastNotification($xml)
$toast.Tag = "w1:p1"; $toast.Group = "herdr"
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
```

Key points:

- Borrow an already-registered AppId (Windows PowerShell's AppUserModelID). The notification carries the "Windows PowerShell" name and icon. A custom identity requires registering an AppId in the registry (future work).
- Setting `Tag` (= pane_id) + `Group` (= "herdr") makes **notifications for the same pane replace each other instead of stacking** — the same effect as the article's `-UniqueIdentifier`.
- Invocation caveats:
  - **Launch with the cwd set to a Windows path (`/mnt/c` etc.).** A WSL-path cwd triggers a UNC path warning.
  - Pass dynamic messages via **`-EncodedCommand` (UTF-16LE Base64)** to avoid PowerShell quoting hell and injection. Strings embedded in the toast XML are XML-escaped.

---

## 3. Implementation plan

### 3.1 Architecture

```
herdr server (WSL)
  └─ [[events]] on = "pane.agent_status_changed"
       └─ node notify.mjs        ... parse HERDR_PLUGIN_EVENT_JSON
            ├─ status filter (only done / blocked pass)
            ├─ suppression checks (enabled flag / WSL detection / skip focused pane)
            └─ powershell.exe -NoProfile -EncodedCommand <base64>
                 └─ WinRT ToastNotificationManager → Windows toast
```

### 3.2 File layout

```
herdr-wsl-notify/
  herdr-plugin.toml     # manifest
  notify.mjs            # event hook entry point (sends the notification)
  toggle.mjs            # on/off toggle action (adapted from the telegram example)
  lib.mjs               # .env loading / state file / shared helpers
  toast.mjs             # PowerShell script generation + EncodedCommand execution
  .env.example          # sample configuration
  docs/DESIGN.md        # this document
  README.md             # setup instructions
```

Zero npm dependencies, Node 18+ only (same policy as the official herdr examples).

### 3.3 Manifest draft

```toml
id = "tkmct.wsl-notify"
name = "WSL Windows Notify"
version = "0.1.0"
min_herdr_version = "0.7.0"
description = "Show a Windows toast when an agent finishes or blocks (WSL)"
platforms = ["linux"]   # WSL = Linux. On non-WSL Linux the script exits immediately

[[events]]
on = "pane.agent_status_changed"
command = ["node", "notify.mjs"]

[[actions]]
id = "toggle"
title = "Toggle Windows notifications"
command = ["node", "toggle.mjs"]

[[actions]]
id = "enable"
title = "Enable Windows notifications"
command = ["node", "toggle.mjs", "on"]

[[actions]]
id = "disable"
title = "Disable Windows notifications"
command = ["node", "toggle.mjs", "off"]

[[actions]]
id = "test"
title = "Send a test toast"
command = ["node", "notify.mjs", "--test"]
```

### 3.4 notify.mjs processing flow

1. **Guards (all exit 0 quietly, but log the reason to stderr so it can be traced via `plugin log`)**
   - `HERDR_PLUGIN_STATE_DIR/enabled` is off → exit
   - WSL detection: `WSL_DISTRO_NAME` set, or `/proc/version` contains `microsoft` → exit if not matched
   - `powershell.exe` existence check (resolved in order: `POWERSHELL_EXE` setting → `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` → PATH)
2. **Event parsing**: read `data.agent_status` / `data.display_agent` / `data.workspace_id` / pane_id from `HERDR_PLUGIN_EVENT_JSON` (falling back to `HERDR_PLUGIN_CONTEXT_JSON` like the telegram example)
3. **Filter**: exit unless the status is in `NOTIFY_ON` (default `done,blocked`)
4. **Suppression (optional)**:
   - Skip notifications for the focused pane (when `SKIP_FOCUSED=1`, judged from focus info in the context) — no point notifying about a pane the user is already looking at
   - Debounce consecutive identical notifications for the same pane for a few seconds via `STATE_DIR/last-<pane_id>` (guards against status flapping; tune with `DEBOUNCE_MS`)
5. **Message building**: e.g. `✅ Claude is done` / `⚠️ Claude is blocked`, with a second line `workspace · terminal_title_stripped` (so you can tell what the work was)
6. **Send**: XML-escape → build the PowerShell script string → encode as UTF-16LE Base64 → `spawn(powershellExe, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", b64], { cwd: "/mnt/c" })`
   - Toast `Tag` = pane_id, `Group` = `"herdr"` so each pane's toast is replaced
   - With a timeout (e.g. 10 s). Failures go to stderr (which lands in herdr's plugin log)

### 3.5 Configuration (`HERDR_PLUGIN_CONFIG_DIR/.env`)

```sh
# Statuses to notify on (comma separated: done, blocked, idle)
NOTIFY_ON=done,blocked
# Do not notify for the focused pane
SKIP_FOCUSED=1
# Debounce window for same pane + same status (ms)
DEBOUNCE_MS=3000
# Override the powershell.exe path (normally unnecessary)
#POWERSHELL_EXE=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
# AppId used as the toast sender identity (normally unnecessary)
#TOAST_APP_ID=...
```

### 3.6 Implementation steps

1. `lib.mjs`: port `.env` loading, the enabled-state file, and env helpers from the telegram example
2. `toast.mjs`: message (title, body, tag) → generate the PowerShell WinRT script → run via `-EncodedCommand`. Make it runnable standalone via `--test`
3. `notify.mjs`: implement the flow above
4. `toggle.mjs`: toggle the enabled file (mostly reused from the telegram example)
5. `herdr plugin link .` → check warnings with `herdr plugin list` → `action invoke test` → trigger real `done` / `blocked` transitions with an actual agent → check logs with `herdr plugin log list --plugin tkmct.wsl-notify`
6. Polish the README (install instructions, keybinding example)

### 3.7 Testing and debugging

- Run `node notify.mjs --test` directly (make the test toast work even without `HERDR_*` variables)
- Simulate an event with `HERDR_PLUGIN_EVENT_JSON='{"data":{"agent_status":"done","display_agent":"claude"}}' node notify.mjs`
- In production, `herdr plugin log list` is the main debugging tool (hook stdout/stderr is recorded)
- If status transitions don't match expectations, inspect the detection evidence with `herdr agent explain <pane>`

### 3.8 Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Notification storms from status flapping (Claude Code uses screen detection, so misdetection is possible) | Replacement via Tag + debounce. herdr's `blocked` detection is intentionally strict |
| PowerShell quoting/injection (the terminal title is an arbitrary string) | `-EncodedCommand` + XML escaping. argv launch without a shell |
| Hidden by Windows "Do not disturb" (Focus Assist) | Documented in the README as expected behavior (still lands in the notification center) |
| Environments with interop disabled (`interop=false` in `/etc/wsl.conf`) | Exit quietly when powershell.exe resolution fails, with a hint on stderr |
| Installation on non-WSL Linux | Exit immediately on WSL detection failure (`platforms = linux` alone cannot prevent this) |

### 3.9 Future work (out of scope for v1)

- **Bring the terminal to the foreground on toast click**: the Zenn article's approach (register a custom URI protocol `herdr-toast:` in the registry + focus.ps1 to raise the window + an empty Alt keystroke to bypass the foreground lock). Combined with `herdr agent focus` / `pane.focus` via `HERDR_BIN_PATH`, it could jump directly to the pane
- Register a custom AppId (change the sender identity from "Windows PowerShell" to "Herdr")
- Auto-upgrade to rich toasts (buttons, sound) when BurntToast is detected
- Marketplace publication (add the GitHub topic `herdr-plugin`)

---

## 4. References

- herdr Plugins: https://herdr.dev/docs/plugins/
- herdr Socket API (event list): https://herdr.dev/docs/socket-api/
- herdr Agents (how status detection works): https://herdr.dev/docs/agents/
- Official examples: https://github.com/ogulcancelik/herdr-plugin-examples (especially `agent-telegram-notify`)
- WSL → Windows toast notifications (Zenn / yakborg): https://zenn.dev/yakborg/articles/wsl-claude-code-windows-toast
- Toast content XML (ToastGeneric): https://learn.microsoft.com/en-us/windows/apps/design/shell/tiles-and-notifications/adaptive-interactive-toasts
