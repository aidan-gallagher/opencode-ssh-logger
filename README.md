# opencode-ssh-logger

An [OpenCode](https://opencode.ai) plugin that logs all SSH commands and their output to human-readable text files.

Every time the AI agent runs an SSH command through OpenCode's bash tool, the command and its output are appended to a log file. Logs are written per-session and to a global log.

## Setup

Add the plugin to your `opencode.json`:


```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-ssh-logger@latest"]
}
```

No configuration required.

## Command

The plugin adds an `/ssh-logger` command that shows where SSH logs are written.

## Log files

Logs are written to `$XDG_DATA_HOME/opencode/storage/plugins/opencode-ssh-logger/` (defaults to `~/.local/share/opencode/storage/plugins/opencode-ssh-logger/`):

```
~/.local/share/opencode/storage/plugins/opencode-ssh-logger/
├── ssh-all.log                  # Global log (all sessions)
├── ssh-ses_ABC123DEF456.log     # Per-session logs
├── ssh-ses_XYZ789GHI012.log
```

- **`ssh-all.log`** — Every SSH command across all OpenCode sessions, in chronological order.
- **`ssh-<sessionID>.log`** — Commands from a single OpenCode session, correlating to the session ID in the TUI.
