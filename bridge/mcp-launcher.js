// Starts Codex's computer-use MCP server (cua_repl) for Claude Code as "codex-cu".
//
// The Codex desktop app writes that server's command and environment to a
// .mcp.json in its plugin cache, and rewrites it when it restarts or updates
// (new native pipe, new runtime paths). Reading it at every start keeps
// codex-cu working without re-registering. Two settings differ from Codex's:
// only the computer surface is enabled (the browser surface needs Codex
// itself), and the sky service that surface uses is trusted.
//
// The launcher passes MCP messages between Claude Code and the server. If
// Codex restarts during a session, the server's pipe is gone for good, and
// Claude Code still shows codex-cu as connected. So before each tool call the
// launcher checks the pipe; when Codex has opened a new one, it starts a fresh
// server from the rewritten .mcp.json, replays Claude Code's initialize
// handshake to it, and notes in that call's result that the REPL was reset.
//
//   node mcp-launcher.js           run the server on stdin/stdout
//   node mcp-launcher.js --check   print what would run and whether Codex is reachable
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const readline = require("readline");

const RESTART_NOTE =
  "codex-cu restarted because the Codex app restarted, so the REPL state was reset: " +
  "variables and window bindings from earlier calls are gone. " +
  "Run `await cua.getState();` on its own, then bind the window again.";
const RESTART_ERROR = "codex-cu restarted because the Codex app restarted before this call finished. Retry it.";

function pluginRoot() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "plugins", "cache", "openai-bundled", "unified-computer-use");
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// The newest plugin version whose .mcp.json has a cua_repl server.
function findServer() {
  const root = pluginRoot();
  let versions;
  try {
    versions = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+(\.\d+)*$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersions)
      .reverse();
  } catch {
    throw new Error(
      `Codex's computer-use plugin isn't installed (no ${root}). ` +
        "Install the Codex desktop app and open it once.",
    );
  }
  for (const version of versions) {
    const file = path.join(root, version, ".mcp.json");
    try {
      const server = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers?.cua_repl;
      if (server?.command) return { version, file, server };
    } catch {}
  }
  throw new Error(`No .mcp.json with a cua_repl server under ${root}. Open the Codex desktop app once.`);
}

function serverEnv(server) {
  const env = { ...process.env, ...server.env };
  let services = {};
  try {
    services = JSON.parse(env.NODE_REPL_TRUSTED_SERVICES || "{}");
  } catch {}
  services.sky = "@oai/sky/service";
  env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify(services);
  env.CUA_REPL_ENABLED_SURFACES = "computer";
  return env;
}

// Codex serves this pipe while it's running. Missing means Codex is closed, or
// it restarted after this .mcp.json was read. null when it can't be checked.
// Listing the pipe folder is safe; opening the pipe itself would connect to it.
function codexPipeOpen(env) {
  const pipe = String(env.SKY_CUA_NATIVE_PIPE_DIRECTORY || "").replace(/^\\\\\.\\pipe\\/i, "").toLowerCase();
  if (!pipe) return null;
  try {
    return fs.readdirSync("//./pipe/").some((name) => name.toLowerCase().startsWith(pipe));
  } catch {
    return null;
  }
}

// The server to switch to when Codex has restarted: this server's pipe is gone
// and .mcp.json names another one that is open. null when nothing changed, or
// Codex is closed (the call then fails with Codex's own "pipe unavailable").
function serverAfterCodexRestart(env) {
  if (codexPipeOpen(env) !== false) return null;
  let found;
  try {
    found = findServer();
  } catch {
    return null;
  }
  const next = serverEnv(found.server);
  if (next.SKY_CUA_NATIVE_PIPE_DIRECTORY === env.SKY_CUA_NATIVE_PIPE_DIRECTORY) return null;
  return codexPipeOpen(next) ? { found, env: next } : null;
}

// While Codex works on the computer, it shows "Codex is using your computer"
// with a glow around the screen until the computer-use turn ends. Codex ends
// its own turns when they complete, but calls from Claude Code don't belong to
// a Codex turn, so the approval hook calls this when Claude's turn ends. It
// sends end_turn over Codex's pipe (frames: 4-byte little-endian length, then
// JSON), as Codex's own client does. Resolves to false when Codex isn't running.
function endComputerUseTurn(env, timeoutMs = 5000) {
  if (codexPipeOpen(env) === false) return Promise.resolve(false);
  const body = Buffer.from(
    JSON.stringify({ id: 1, jsonrpc: "2.0", method: "request", params: { method: "end_turn", params: {} } }),
  );
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);

  return new Promise((resolve, reject) => {
    const socket = net.connect(env.SKY_CUA_NATIVE_PIPE_DIRECTORY, () => socket.write(frame));
    const timer = setTimeout(() => done(new Error(`Codex didn't answer end_turn within ${timeoutMs} ms`)), timeoutMs);
    function done(error) {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(true);
    }
    let data = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4 && data.length >= 4 + data.readUInt32LE(0)) {
        const length = data.readUInt32LE(0);
        const message = parse(data.subarray(4, 4 + length).toString("utf8"));
        data = data.subarray(4 + length);
        if (message?.id === 1) return done(message.error ? new Error(message.error.message) : null);
      }
    });
    socket.on("error", done);
  });
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// JSON-RPC ids can be numbers or strings; keep 1 and "1" apart.
const idKey = (id) => JSON.stringify(id);
const isRequest = (msg) => typeof msg?.method === "string" && msg.id != null;
const isResponse = (msg) => msg != null && msg.method === undefined && msg.id != null;

// MCP over stdio: one JSON-RPC message per line, both ways.
function runServer(first) {
  let env = serverEnv(first.server);
  let server = null;
  let initializeRequest = null; // Claude Code's, replayed to a restarted server
  let initializedSent = false;
  const pending = new Set(); // ids of Claude Code requests the server hasn't answered
  let held = null; // Claude Code's messages while a restarted server initializes
  let replayId = null; // id of the replayed initialize
  let restarts = 0;
  let noteFor = null; // id of the call whose result gets RESTART_NOTE

  const toClient = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

  function start(found) {
    const child = spawn(found.server.command, found.server.args ?? [], {
      stdio: ["pipe", "pipe", "inherit"],
      env,
      windowsHide: true,
    });
    child.stdin.on("error", () => {}); // a server that died is handled by "exit"
    child.on("error", (error) => {
      if (child !== server) return;
      process.stderr.write(`codex-cu: can't start ${found.server.command}: ${error.message}\n`);
      process.exit(1);
    });
    child.on("exit", (code) => {
      if (child === server) process.exit(code ?? 1);
    });
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (child === server) fromServer(line);
    });
    return child;
  }

  function toServer(line, msg) {
    if (isRequest(msg)) pending.add(idKey(msg.id));
    server.stdin.write(line + "\n");
  }

  function fromServer(line) {
    const msg = parse(line);
    if (isResponse(msg)) {
      const key = idKey(msg.id);
      if (key === replayId) return finishRestart(msg);
      pending.delete(key);
      if (key === noteFor) {
        noteFor = null;
        if (Array.isArray(msg.result?.content)) msg.result.content.unshift({ type: "text", text: RESTART_NOTE });
        else if (msg.error) msg.error.message = `${RESTART_NOTE} ${msg.error.message}`;
        return toClient(msg);
      }
    }
    process.stdout.write(line + "\n");
  }

  function restart(next, line, msg) {
    const old = server;
    // The old server won't answer what it still had; don't leave Claude Code waiting.
    for (const key of pending) toClient({ jsonrpc: "2.0", id: JSON.parse(key), error: { code: -32603, message: RESTART_ERROR } });
    pending.clear();
    env = next.env;
    server = start(next.found);
    // Close the old server's input (MCP's stdio shutdown), and stop it if it lingers.
    old.stdin.end();
    setTimeout(() => old.kill(), 5000).unref();

    held = [line];
    noteFor = idKey(msg.id);
    const id = `codex-cu-launcher-initialize-${++restarts}`;
    replayId = idKey(id);
    server.stdin.write(JSON.stringify({ ...initializeRequest, id }) + "\n");
  }

  function finishRestart(response) {
    replayId = null;
    if (response.error) {
      process.stderr.write(`codex-cu: the restarted server refused initialize: ${response.error.message}\n`);
      process.exit(1);
    }
    if (initializedSent) server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const lines = held;
    held = null;
    for (const line of lines) toServer(line, parse(line));
  }

  function fromClient(line) {
    const msg = parse(line);
    if (msg?.method === "initialize") initializeRequest = msg;
    if (msg?.method === "notifications/initialized") initializedSent = true;
    if (held) return void held.push(line);
    if (msg?.method === "tools/call" && msg.id != null && initializeRequest) {
      const next = serverAfterCodexRestart(env);
      if (next) return restart(next, line, msg);
    }
    toServer(line, msg);
  }

  server = start(first);
  process.stdout.on("error", () => {}); // Claude Code went away; its stdin closing ends us
  readline
    .createInterface({ input: process.stdin, crlfDelay: Infinity })
    .on("line", (line) => {
      if (line.trim()) fromClient(line);
    })
    .on("close", () => server.stdin.end());
}

function main() {
  let found;
  try {
    found = findServer();
  } catch (error) {
    process.stderr.write(`codex-cu: ${error.message}\n`);
    process.exit(1);
  }

  if (process.argv.includes("--check")) {
    const env = serverEnv(found.server);
    const check = {
      plugin: found.version,
      config: found.file,
      runtime: found.server.command,
      runtimeExists: fs.existsSync(found.server.command),
      codexRunning: codexPipeOpen(env),
    };
    process.stdout.write(JSON.stringify(check, null, 2) + "\n");
    return;
  }

  runServer(found);
}

if (require.main === module) main();

module.exports = { findServer, serverEnv, codexPipeOpen, serverAfterCodexRestart, endComputerUseTurn };
