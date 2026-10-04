// Installs Codex computer use for Claude Code on Windows, or removes it.
//   install.cmd              install, or update after pulling a new version
//   install.cmd uninstall    remove everything this installs
//
// Install copies the skill and the bridge into the Claude config folder
// (%USERPROFILE%\.claude, or CLAUDE_CONFIG_DIR), adds its hooks (app approvals,
// and ending Codex's computer-use turn) to its settings.json, and registers the
// codex-cu MCP server for the user.
// Files it changes are backed up next to themselves first.
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const SERVER = "codex-cu";
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(os.homedir(), ".claude");
// User-scope MCP servers live in .claude.json: next to the config folder by
// default, inside it when CLAUDE_CONFIG_DIR is set.
const CLAUDE_JSON = process.env.CLAUDE_CONFIG_DIR
  ? path.join(CLAUDE_DIR, ".claude.json")
  : path.join(os.homedir(), ".claude.json");
const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const BRIDGE_DIR = path.join(CLAUDE_DIR, "codex-computer-use");
const BRIDGE_CMD = path.join(BRIDGE_DIR, "codex-cu.cmd");
const SKILL_DIR = path.join(CLAUDE_DIR, "skills", "codex-computer-use");
const COMSPEC = process.env.ComSpec || "cmd.exe";

// .cmd files need cmd.exe. Claude Code starts the hook and the server without
// a shell (exec form), so it works whether it would use Git Bash or PowerShell.
const HOOK = { type: "command", command: COMSPEC, args: ["/d", "/c", BRIDGE_CMD, "hook"] };
// Stop takes no matcher: it ends Codex's computer-use turn when Claude's ends.
const HOOK_MATCHERS = {
  Elicitation: SERVER,
  PreToolUse: `mcp__${SERVER}__.*`,
  PostToolUse: `mcp__${SERVER}__.*`,
  PostToolUseFailure: `mcp__${SERVER}__.*`,
  Stop: null,
};
const MCP_SERVER = { type: "stdio", command: COMSPEC, args: ["/d", "/c", BRIDGE_CMD, "mcp"], env: {} };

function say(line = "") {
  process.stdout.write(line + "\n");
}

function fail(message) {
  const error = new Error(message);
  error.expected = true;
  throw error;
}

function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
  // Skip a byte order mark, which some editors add.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${file} isn't valid JSON (${error.message}). Fix it, then run this again.`);
  }
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const copy = `${file}.backup-${stamp}`;
  fs.copyFileSync(file, copy);
  say(`  backup: ${copy}`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.codex-cu-tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temp, file);
}

// Hooks from this installer, or from the earlier manual setup.
function isOurHook(hook) {
  const text = [hook?.command, ...(Array.isArray(hook?.args) ? hook.args : [])].join(" ");
  return /codex-cu-approval\.js|codex-computer-use[\\/]codex-cu\.cmd/i.test(text);
}

function updateSettings(install) {
  const settings = readJson(SETTINGS, {});
  const before = JSON.stringify(settings);
  const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};

  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const groups = hooks[event].flatMap((group) => {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(isOurHook)) return [group];
      const rest = group.hooks.filter((hook) => !isOurHook(hook));
      return rest.length ? [{ ...group, hooks: rest }] : [];
    });
    if (groups.length) hooks[event] = groups;
    else if (hooks[event].length) delete hooks[event];
  }
  if (install) {
    for (const [event, matcher] of Object.entries(HOOK_MATCHERS)) {
      if (!Array.isArray(hooks[event])) hooks[event] = [];
      hooks[event].push(matcher == null ? { hooks: [HOOK] } : { matcher, hooks: [HOOK] });
    }
  }
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;

  if (JSON.stringify(settings) === before) {
    say(`  ${SETTINGS}: hooks already up to date`);
    return;
  }
  backup(SETTINGS);
  writeJson(SETTINGS, settings);
  say(`  ${SETTINGS}: codex-cu hooks ${install ? "added" : "removed"}`);
}

function runClaude(args) {
  return spawnSync("claude", args, { encoding: "utf8", windowsHide: true });
}

function updateMcp(install) {
  if (!runClaude(["--version"]).error) {
    runClaude(["mcp", "remove", SERVER, "--scope", "user"]);
    if (install) {
      const added = runClaude(["mcp", "add-json", SERVER, JSON.stringify(MCP_SERVER), "--scope", "user"]);
      if (added.status !== 0) {
        fail(`claude mcp add-json failed: ${(added.stderr || added.stdout || "").trim()}`);
      }
    }
    say(`  MCP server "${SERVER}" ${install ? "registered" : "removed"} (claude mcp, user scope)`);
    return;
  }

  // No claude command (for example, only the desktop app is installed): edit
  // the user MCP config directly.
  const config = readJson(CLAUDE_JSON, {});
  const servers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  if (!install && !(SERVER in servers)) return;
  if (install && JSON.stringify(servers[SERVER]) === JSON.stringify(MCP_SERVER)) {
    say(`  MCP server "${SERVER}" already registered in ${CLAUDE_JSON}`);
    return;
  }
  if (install) servers[SERVER] = MCP_SERVER;
  else delete servers[SERVER];
  config.mcpServers = servers;
  backup(CLAUDE_JSON);
  writeJson(CLAUDE_JSON, config);
  say(`  MCP server "${SERVER}" ${install ? "registered in" : "removed from"} ${CLAUDE_JSON}`);
}

function copyFiles() {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  for (const name of ["codex-cu.cmd", "mcp-launcher.js", "approval-hook.js"]) {
    fs.copyFileSync(path.join(REPO, "bridge", name), path.join(BRIDGE_DIR, name));
  }
  say(`  bridge: ${BRIDGE_DIR}`);

  // Copy next to the old skill first, so a failed copy leaves it in place.
  const fresh = `${SKILL_DIR}.new`;
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.cpSync(path.join(REPO, "skill", "codex-computer-use"), fresh, { recursive: true });
  fs.rmSync(SKILL_DIR, { recursive: true, force: true });
  fs.renameSync(fresh, SKILL_DIR);
  say(`  skill:  ${SKILL_DIR}`);
}

function runBridge(args, input) {
  return spawnSync(COMSPEC, ["/d", "/c", BRIDGE_CMD, ...args], { encoding: "utf8", input, windowsHide: true });
}

// Starts the bridge the way Claude Code will, so a broken path shows up now.
function checkBridge() {
  const hook = runBridge(["hook"], JSON.stringify({ hook_event_name: "PreToolUse", session_id: "" }));
  if (hook.status !== 0) fail(`The approval hook didn't run: ${(hook.stderr || "").trim()}`);

  const result = runBridge(["mcp", "--check"]);
  let check;
  try {
    check = JSON.parse(result.stdout);
  } catch {
    fail(`The codex-cu server can't start: ${(result.stderr || result.stdout || "").trim()}`);
  }
  if (!check.runtimeExists) {
    fail(`Codex's runtime is missing (${check.runtime}). Open the Codex desktop app so it can finish updating, then run this again.`);
  }
  say(`  Codex computer-use plugin ${check.plugin} found`);
  return check;
}

function install() {
  if (process.platform !== "win32") fail("This is for Windows only.");
  if (/[&<>()@^|%!"]/.test(BRIDGE_CMD)) {
    fail(`The install path has characters cmd.exe can't handle: ${BRIDGE_CMD}`);
  }
  try {
    require(path.join(REPO, "bridge", "mcp-launcher.js")).findServer();
  } catch (error) {
    fail(error.message);
  }

  say("Installing Codex computer use for Claude Code");
  copyFiles();
  const check = checkBridge();
  updateSettings(true);
  updateMcp(true);

  const oldHook = path.join(CLAUDE_DIR, "hooks", "codex-cu-approval.js");
  if (fs.existsSync(oldHook)) {
    say(`  note: ${oldHook} (and its .log / -state.json) is from the old manual setup and no longer used; you can delete it`);
  }

  say();
  say("Done.");
  if (check.codexRunning === false) say("Codex isn't running right now: start the Codex desktop app before using it.");
  say("Start a new Claude Code session (restart the Claude desktop app if it's open), then ask for example:");
  say('  "Open Calculator and compute 12 x 12"');
  say("The first time each app is used in a session, Claude Code asks you to allow it.");
}

function uninstall() {
  say("Removing Codex computer use from Claude Code");
  updateMcp(false);
  updateSettings(false);
  fs.rmSync(SKILL_DIR, { recursive: true, force: true });
  say(`  removed ${SKILL_DIR}`);
  fs.rmSync(BRIDGE_DIR, { recursive: true, force: true });
  say(`  removed ${BRIDGE_DIR}`);
  say();
  say("Done. Start a new Claude Code session for it to take effect.");
}

try {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) fail(`Node.js ${process.versions.node} is too old; 18 or newer is needed.`);
  const command = (process.argv[2] || "install").toLowerCase();
  if (command === "install") install();
  else if (command === "uninstall") uninstall();
  else fail(`Unknown command "${process.argv[2]}". Use: install.cmd [install | uninstall]`);
} catch (error) {
  say();
  say(`Error: ${error.expected ? error.message : error.stack}`);
  process.exitCode = 1;
}
