# Codex computer use for Claude Code (Windows)

Lets Claude Code drive Windows desktop apps: open them, click, type, press keys, take screenshots and describe what's on screen. It uses the computer-use engine that ships with OpenAI's Codex desktop app. Works in the `claude` CLI and in the Claude desktop app's Code tab.

Like in Codex, each app needs your approval, here shown in Claude Code's own permission prompt.

> Unofficial. It reuses Codex's bundled computer-use runtime, so a Codex update could break it.

## Requirements

- Windows 10 or 11
- The **Codex desktop app** with Computer Use. Open it once so it sets up its computer-use plugin; it must be running whenever Claude uses an app. If you restart Codex, Claude picks it up again on its next call, without a new session.
- **Claude Code**: the `claude` CLI, or the Claude desktop app (Code tab)

You don't need Node.js: the installer uses the one bundled with Codex.

## Install

1. Get this repo:
   ```
   git clone https://github.com/TMH13/codex-computer-use-for-claude-code.git
   ```
   or **Code → Download ZIP** on GitHub, and extract it.
2. Double-click **`install.cmd`**. If Windows warns that the file came from the internet, choose **Run**.
3. Start a new Claude Code session (restart the Claude desktop app if it's open).
4. Ask Claude something like: *"Open Calculator and compute 12 × 12"*.

## Approvals

The first time Claude uses an app in a session, its first attempt fails on purpose and Claude retries. You then get a Claude Code permission prompt that says *Codex Computer Use is asking: "Allow Codex to use Calculator?"*:

- **Allow once** approves that app for the rest of the session.
- **Deny** refuses it, and Claude stops.

Choosing "Always allow" for the codex-cu tool doesn't skip these per-app prompts.

## What the installer changes

Everything goes into your Claude config folder, `%USERPROFILE%\.claude` (or `CLAUDE_CONFIG_DIR` if you set one):

| What | Where |
|---|---|
| The skill that tells Claude how to use it | `skills\codex-computer-use\` |
| The bridge: server launcher, hook script, approval log | `codex-computer-use\` |
| Five hook entries: four for approvals (Elicitation, PreToolUse, PostToolUse, PostToolUseFailure), one to clear Codex's on-screen indicator (Stop) | `settings.json` |
| The `codex-cu` MCP server, for your user | via `claude mcp`, or `%USERPROFILE%\.claude.json` if the `claude` command isn't installed |

The installer backs up any JSON file before changing it (`*.backup-<date>-<time>`), keeps your other settings and hooks, and doesn't modify anything in Codex. Running it again is safe.

## Update and uninstall

- **Update:** `git pull` (or download the ZIP again), then run `install.cmd` again.
- **Uninstall:** double-click `uninstall.cmd`.
- **Codex updates:** nothing to do. The bridge reads Codex's current configuration every time a Claude Code session starts.

## Troubleshooting

To check what the bridge finds (after installing), run this in PowerShell, which is what Windows Terminal opens by default:

```powershell
& "$env:USERPROFILE\.claude\codex-computer-use\codex-cu.cmd" mcp --check
```

or this in a Command Prompt (`cmd`):

```bat
"%USERPROFILE%\.claude\codex-computer-use\codex-cu.cmd" mcp --check
```

It shows the Codex plugin version, whether Codex's runtime exists, and whether Codex is running.

| Problem | Fix |
|---|---|
| Claude doesn't have the codex-cu tool, or the check above says the path isn't recognized | Run `install.cmd`, then start a new session |
| "Computer Use native pipe is unavailable" | Start Codex, then ask Claude to try again. If it still fails, start a new session |
| "node_repl kernel exited unexpectedly" | Codex updated mid-session: once Codex is open again, ask Claude to try again. If it still fails, start a new session |
| Apps fail with "not approved" and no prompt appears | Run `install.cmd` again, then start a new session |
| "Codex is using your computer" stays after Claude is done | If you stopped Claude mid-reply, the hook that clears it didn't run: it clears when Claude's next reply in that session ends. Otherwise, run `install.cmd` again, then start a new session |

Every approval decision is logged in `%USERPROFILE%\.claude\codex-computer-use\codex-cu-approvals.log`. There's more detail in [the skill's setup reference](skill/codex-computer-use/references/setup.md).

## How it works

- **`codex-cu` MCP server.** It runs `bridge\mcp-launcher.js`, which starts Codex's computer-use server (`cua_repl`) with the command and environment Codex wrote to its plugin's `.mcp.json`. It enables only the computer surface (the browser surface needs Codex itself).
- **Approvals.** Codex asks for each app with an MCP elicitation, which the Code tab doesn't display. `bridge\approval-hook.js` declines the first request and turns the retry into a Claude Code permission prompt. It then remembers an Allow for the rest of that session.
- **"Codex is using your computer".** While Claude works in an app, Codex shows this message with a glow around the screen, as it does for its own tasks. Codex removes it when its own task ends, but it can't tell when Claude's has. So when Claude finishes a reply in which it used codex-cu, the same hook script (on `Stop`) tells Codex the turn is over, and the indicator goes away.
- **The skill.** `skill\codex-computer-use` teaches Claude the workflow (observe → act → verify) and the Windows quirks (key names, coordinates, windows that resize, clicking in dialogs and menus). It also sets safety rules: no credentials, confirm before irreversible actions, no terminals or system settings.
- **Hooks and server launch.** Both run through `cmd.exe` in exec form, so they don't depend on Git Bash or PowerShell.

## License

[MIT](LICENSE)
