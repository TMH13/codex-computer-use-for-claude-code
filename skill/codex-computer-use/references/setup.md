# codex-cu setup and troubleshooting

Read this when `mcp__codex-cu__js` is missing, a call fails with a setup error, or the user asks how to install, update or remove codex-cu.

**Who changes config:** don't edit Claude Code's settings, its MCP registration or the files below yourself. Tell the user what to run. MCP servers and hooks load when a session starts, so after any change the user needs a new Claude Code session (or a restart of the Claude desktop app).

## Install, update, remove

Everything is installed by the repo https://github.com/TMH13/codex-computer-use-for-claude-code:

- **Install or update:** get the repo (`git clone`, or Download ZIP and extract), then double-click `install.cmd`. To update, `git pull` (or download again), then run `install.cmd` again.
- **Remove:** double-click `uninstall.cmd`.

Requirements: Windows 10/11, the Codex desktop app with Computer Use, opened at least once, and Claude Code (the CLI or the Claude desktop app's Code tab). Codex ships its own Node.js, which the installer and the bridge use, so Node.js doesn't need to be installed.

## How it's wired

The installer puts everything in the Claude config folder, `%USERPROFILE%\.claude` (or `CLAUDE_CONFIG_DIR`):

- `skills\codex-computer-use\`: this skill.
- `codex-computer-use\`: the bridge.
  - `codex-cu.cmd`: finds Codex's `node.exe` (in `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\<hash>\bin`, or `node` on PATH) and runs one of the two scripts below.
  - `mcp-launcher.js`: starts Codex's computer-use server.
    - It reads the server's command and environment from the newest `%USERPROFILE%\.codex\plugins\cache\openai-bundled\unified-computer-use\<version>\.mcp.json` (entry `cua_repl`) each time it starts. Codex rewrites that file when it restarts or updates, so nothing needs re-registering.
    - It changes two settings: `CUA_REPL_ENABLED_SURFACES=computer`, and `sky` is added to `NODE_REPL_TRUSTED_SERVICES`.
    - It passes MCP messages between Claude Code and the server. Before each tool call it checks Codex's pipe. If Codex restarted (this server's pipe is gone and `.mcp.json` names a new one that is open), it starts a fresh server, replays Claude Code's `initialize` to it, and puts a note at the start of that call's result saying the REPL was reset. Calls still running on the old server end with an error that says to retry. Claude Code keeps showing codex-cu as connected throughout, so this is the only way it recovers without a new session.
  - `approval-hook.js`: turns Codex's app approvals into Claude Code's own permission prompt (see SKILL.md).
    - Codex asks with an MCP form elicitation that has no fields, which the Claude desktop app's Code tab doesn't show.
    - It logs every decision to `codex-cu-approvals.log` and keeps session state in `codex-cu-approvals-state.json`, both next to it. Those files are the user's audit trail; don't edit them.
    - On `Stop` (Claude finished a reply), if the session used codex-cu since its last `Stop`, it sends `end_turn` over Codex's pipe. That ends Codex's computer-use turn, which hides the "Codex is using your computer" message and the glow around the screen. Codex does this itself at the end of its own tasks, but Claude's calls aren't part of a Codex task. The computer-use helper is shared, so this also clears the indicator of a Codex task running at the same time. `Stop` doesn't run when the user interrupts Claude; the indicator then clears at the end of the session's next reply.
- `settings.json`: hooks for `Elicitation` (matcher `codex-cu`), `PreToolUse` / `PostToolUse` / `PostToolUseFailure` (matcher `mcp__codex-cu__.*`) and `Stop` (no matcher). They run `cmd.exe /d /c <bridge>\codex-cu.cmd hook` in exec form, so they don't depend on Git Bash or PowerShell.
- User MCP config (`claude mcp add-json`, or `.claude.json` directly if the `claude` command isn't installed): server `codex-cu`, which runs `cmd.exe /d /c <bridge>\codex-cu.cmd mcp`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No `mcp__codex-cu__js` tool | Not installed, or installed after this session started | Run `install.cmd`, then start a new session |
| `codex-cu` fails to start; the MCP log says the plugin isn't installed | The Codex desktop app is missing, or has never been opened | Install or open Codex, then start a new session |
| `getState()` → `errors: ["Native apps: Error: Computer Use native pipe is unavailable … (os error 2)"]` | Codex isn't running | Ask the user to start Codex, then retry; the launcher switches to Codex's new pipe. If it still fails, start a new session |
| `node_repl kernel exited unexpectedly … program not found` | Codex updated while this session's server was running | Once Codex is open again, retry. If it still fails, start a new session |
| A result starts with `codex-cu restarted because the Codex app restarted` | Codex restarted, and the launcher started a fresh server | Expected. Earlier variables and window bindings are gone: run `await cua.getState();` on its own, then bind the window again. A call that ended with `… before this call finished. Retry it.` never completed; retry it |
| `Trusted RPC service is not configured: sky` | An old manual registration copied straight from `.mcp.json` | Run `install.cmd`, then start a new session |
| `Computer Use was not approved to use <App>` on every call, with no prompt | The approval hooks aren't installed or didn't load | Run `install.cmd`, then start a new session |
| The user denied the prompt | Expected; the call never ran | Stop; ask the user before trying that app again |
| "Codex is using your computer" and the glow stay after Claude's reply ended | The user interrupted the reply, so `Stop` didn't run; or the `Stop` hook isn't installed; or Codex didn't answer (the log has `ending Codex's computer-use turn failed`) | After an interrupt, it clears when the next reply ends. Otherwise, run `install.cmd`, then start a new session |

To see what the bridge would start and whether Codex is reachable, the user can run:

```powershell
& "$env:USERPROFILE\.claude\codex-computer-use\codex-cu.cmd" mcp --check
```

And the hook's recent approval decisions and errors:

```powershell
Get-Content "$env:USERPROFILE\.claude\codex-computer-use\codex-cu-approvals.log" -Tail 20
```
