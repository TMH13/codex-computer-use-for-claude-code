// Claude Code hook for codex-cu: asks Codex Computer Use's app approvals
// ("Allow Codex to use Calculator?") through Claude Code's own permission
// prompt, and remembers an approval for the rest of that Claude session, like
// Codex's "Allow this conversation".
//
// A hook can't open Claude Code's prompt in the middle of a tool call, so a new
// app takes two steps:
//   1. Elicitation: Codex asks about an app this session hasn't approved. The
//      request is declined and recorded as pending, so that call fails.
//   2. PreToolUse: while anything is pending, the next codex-cu call goes
//      through Claude Code's permission prompt, with Codex's question as the
//      reason. If the user allows the call, Codex asks again during it, and the
//      request is accepted and remembered. If the user denies it, the call never
//      runs, so Codex never asks and nothing is approved.
// A question that was asked but not answered by the end of the next call (the
// user denied it, or the allowed call didn't need it) is dropped, so it isn't
// asked again on every later call; if Codex asks again, it starts at step 1.
// PostToolUse / PostToolUseFailure tell Claude to retry once after step 1.
// Errors decline. Requests with form fields are left to Claude Code.
//
// Stop: when Claude finishes a turn in which it used codex-cu, this ends
// Codex's computer-use turn, which hides the "Codex is using your computer"
// overlay (see endComputerUseTurn in mcp-launcher.js).
"use strict";
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "codex-cu-approvals-state.json");
const LOG_FILE = path.join(__dirname, "codex-cu-approvals.log");
const STATE_TTL_MS = 12 * 60 * 60 * 1000;
const NOT_APPROVED = /was not approved to use/i;

let sent = false;

function log(line) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function send(hookSpecificOutput) {
  sent = true;
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

function answerElicitation(action) {
  send({ hookEventName: "Elicitation", action, ...(action === "accept" ? { content: {} } : {}) });
}

// { [sessionId]: { updatedAt, approved: [message], pending: { [message]: { asked } }, turnOpen } },
// dropped 12 hours after a session's last change. turnOpen: codex-cu was used
// since the session's last Stop.
function readState() {
  try {
    const all = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const now = Date.now();
    for (const [id, session] of Object.entries(all)) {
      if (!(now - session.updatedAt < STATE_TTL_MS)) delete all[id];
    }
    return all;
  } catch {
    return {};
  }
}

function writeState(all) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(all, null, 2));
}

function sessionState(all, sessionId) {
  const session = all[sessionId] ?? {};
  session.approved ??= [];
  session.pending ??= {};
  session.updatedAt = Date.now();
  all[sessionId] = session;
  return session;
}

// Drops questions that were already put to the user (see the header).
function dropAsked(session) {
  let dropped = false;
  for (const [message, entry] of Object.entries(session.pending)) {
    if (entry.asked) {
      delete session.pending[message];
      dropped = true;
    }
  }
  return dropped;
}

function onElicitation(request, sessionId) {
  const fields = Object.keys(request.requested_schema?.properties ?? {});
  if (request.mode !== "form" || fields.length > 0) return;

  const message = typeof request.message === "string" ? request.message : "";
  if (!sessionId || !message) return answerElicitation("decline");

  const all = readState();
  const session = sessionState(all, sessionId);

  if (session.approved.includes(message)) {
    log(`accept (remembered for session ${sessionId}): ${message}`);
    return answerElicitation("accept");
  }

  if (session.pending[message]?.asked) {
    session.approved.push(message);
    delete session.pending[message];
    writeState(all);
    log(`accept (allowed in Claude Code's prompt, session ${sessionId}): ${message}`);
    return answerElicitation("accept");
  }

  session.pending[message] = { asked: false };
  writeState(all);
  log(`decline (waiting for Claude Code's prompt, session ${sessionId}): ${message}`);
  answerElicitation("decline");
}

function onPreToolUse(sessionId) {
  if (!sessionId) return;
  const all = readState();
  const session = sessionState(all, sessionId);
  const opened = !session.turnOpen;
  session.turnOpen = true;

  // Still asked here means the user denied the call that asked it.
  const dropped = dropAsked(session);
  const messages = Object.keys(session.pending);
  if (messages.length === 0) {
    if (dropped || opened) writeState(all);
    return;
  }

  // Send the prompt before recording it: if recording fails, the user is still
  // asked and the request stays declined (fail closed).
  send({
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason:
      `Codex Computer Use is asking: ${messages.map((m) => `"${m}"`).join(" ")} ` +
      "Allow approves it for the rest of this Claude session. Deny refuses it.",
  });
  for (const message of messages) session.pending[message].asked = true;
  session.updatedAt = Date.now();
  writeState(all);
  log(`asked in Claude Code's prompt (session ${sessionId}): ${messages.join(" | ")}`);
}

function onToolResult(request, sessionId, event) {
  if (!sessionId) return;
  const all = readState();
  const session = all[sessionId];
  if (!session) return;

  // The call ran, so its prompt was allowed; anything Codex didn't ask again
  // during the call wasn't needed.
  if (dropAsked(session)) writeState(all);

  const text =
    event === "PostToolUseFailure"
      ? String(request.error ?? "")
      : JSON.stringify(request.tool_response ?? "");
  const pending = Object.keys(session.pending);
  if (!NOT_APPROVED.test(text) || pending.length === 0) return;

  send({
    hookEventName: event,
    additionalContext:
      `Codex Computer Use needs the user's approval (${pending.join(" ")}). ` +
      "Retry the same codex-cu js call once: Claude Code will first show the user a " +
      "permission prompt with Codex's question. If the user denies it, stop and don't retry.",
  });
}

async function onStop(sessionId) {
  if (!sessionId) return;
  const all = readState();
  const session = all[sessionId];
  if (!session?.turnOpen) return;
  delete session.turnOpen;
  writeState(all);

  const { findServer, serverEnv, endComputerUseTurn } = require("./mcp-launcher.js");
  await endComputerUseTurn(serverEnv(findServer().server));
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let request;
  try {
    request = JSON.parse(input);
  } catch {
    // Unknown event: exit code 2 declines an elicitation and blocks a tool call.
    process.stderr.write("codex-cu approval hook: unreadable hook input\n");
    process.exitCode = 2;
    return;
  }

  const event = request.hook_event_name;
  const sessionId =
    typeof request.session_id === "string" && request.session_id ? request.session_id : null;

  try {
    if (event === "Elicitation") onElicitation(request, sessionId);
    else if (event === "PreToolUse") onPreToolUse(sessionId);
    else if (event === "PostToolUse" || event === "PostToolUseFailure") {
      onToolResult(request, sessionId, event);
    } else if (event === "Stop") {
      onStop(sessionId).catch((error) => log(`ending Codex's computer-use turn failed: ${error.message}`));
    }
  } catch (error) {
    log(`${event} failed: ${error.message}`);
    if (event === "Elicitation" && !sent) answerElicitation("decline");
  }
});
