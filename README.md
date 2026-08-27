# herdr-wsl-notify

A [Herdr](https://herdr.dev) plugin that shows a Windows desktop toast when an
agent (Claude Code, etc.) running under WSL2 becomes **done** (finished) or
**blocked** (waiting for approval/input).

- Zero dependencies (Node.js 18+ only; no npm packages, no BurntToast install)
- Calls the built-in Windows WinRT API directly via `powershell.exe -EncodedCommand` (~0.4 s measured)
- Notifications for the same pane replace each other instead of stacking (Toast Tag = pane_id)
- Debounce against status flapping, plus skipping of the currently focused pane

See [docs/DESIGN.md](docs/DESIGN.md) for the design and research notes.

## Requirements

- WSL2 with Windows interop enabled (i.e. `powershell.exe` can be launched from WSL)
- Node.js 18+ (on the WSL side)
- Herdr 0.7.0+

## Installation

From GitHub:

```sh
herdr plugin install <owner>/herdr-wsl-notify
```

For local development/use:

```sh
git clone <this-repo>
cd herdr-wsl-notify
herdr plugin link .
```

Verify it works:

```sh
herdr plugin action invoke test --plugin tkmct.wsl-notify
```

If a test toast appears in the bottom-right of your Windows desktop, you are
set. From then on, the hook runs every time Herdr fires a
`pane.agent_status_changed` event and notifies you about agents that become
`done` / `blocked`.

## What the notification shows

```
✅ Claude is done
Issue #3181 Async tag insert        ← what the session is working on (terminal title)
📁 crm (my-workspace)               ← working directory (workspace name)
```

The "what it's working on" line is the current-task summary the agent sets as
the terminal title (tracked by Herdr as `terminal_title_stripped`), fetched at
notification time via `herdr agent get <pane>`. The event payload itself does
not include the title, so if it cannot be fetched (e.g. the pane has already
closed) it falls back to the tab name, then the workspace name.

## Configuration

```sh
CONFIG_DIR="$(herdr plugin config-dir tkmct.wsl-notify)"
cp .env.example "$CONFIG_DIR/.env"
```

| Key | Default | Description |
| --- | --- | --- |
| `NOTIFY_ON` | `done,blocked` | Statuses to notify on (`idle` can be added) |
| `SKIP_FOCUSED` | `1` | Skip notifications for the currently focused pane |
| `DEBOUNCE_MS` | `3000` | Suppression window for repeat notifications for the same pane + status |
| `POWERSHELL_EXE` | auto-detected | Override the path to powershell.exe |
| `TOAST_APP_ID` | Windows PowerShell AppId | Sender identity used for the toast |
| `DEBUG_EVENT` | `0` | Dump event/context JSON to the plugin log |

## Temporarily turning notifications off / on

```sh
herdr plugin action invoke toggle --plugin tkmct.wsl-notify
herdr plugin action invoke enable --plugin tkmct.wsl-notify
herdr plugin action invoke disable --plugin tkmct.wsl-notify
```

To bind it to a key, add this to Herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+n"
type = "plugin_action"
command = "tkmct.wsl-notify.toggle"
description = "toggle Windows notifications"
```

## Troubleshooting

- Hook execution logs: `herdr plugin log list --plugin tkmct.wsl-notify`
- No notifications appearing:
  - While Windows "Do not disturb" (Focus Assist) is on, no banner is shown (it still lands in the notification center)
  - Check interop with `ls /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`
  - Run `node notify.mjs --test` directly in the plugin directory and look at the error
- Agent status detection doesn't match expectations: check the evidence with
  `herdr agent explain <pane>`. Installing `herdr integration install claude`
  improves session detection.

## About the sender identity

By default the toast sender shows as "Windows PowerShell" (we borrow its
registered AppId). Using a custom identity requires registering an
AppUserModelID in the registry, which is out of scope for v1 (see the future
work section in docs/DESIGN.md).
