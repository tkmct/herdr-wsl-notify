import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  envFlag,
  envInt,
  loadDotEnv,
  modeEnabled,
  readJsonEnv,
  stateDir,
} from "./lib.mjs";
import { isWsl, sendToast } from "./toast.mjs";

loadDotEnv();

if (!isWsl()) {
  console.error("not running under WSL; skipping");
  process.exit(0);
}

if (process.argv.includes("--test")) {
  await sendToast({
    title: "🔔 Herdr",
    body: "Test notification from herdr-wsl-notify",
    tag: "test",
  });
  console.error("test toast sent");
  process.exit(0);
}

if (!modeEnabled()) {
  process.exit(0);
}

const event = readJsonEnv("HERDR_PLUGIN_EVENT_JSON");
const context = readJsonEnv("HERDR_PLUGIN_CONTEXT_JSON");

if (envFlag("DEBUG_EVENT", false)) {
  console.error(`event=${process.env.HERDR_PLUGIN_EVENT_JSON ?? ""}`);
  console.error(`context=${process.env.HERDR_PLUGIN_CONTEXT_JSON ?? ""}`);
}

const status = statusFrom(event, context);
const notifyOn = (process.env.NOTIFY_ON ?? "done,blocked")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

if (!status || !notifyOn.includes(status)) {
  process.exit(0);
}

const paneId = paneIdFrom(event, context) ?? "unknown";

// Live snapshot of the pane's agent: session summary (terminal title), cwd,
// and an authoritative focused flag. Best-effort; undefined when the pane is
// already gone or the CLI call fails.
const snapshot = agentSnapshot(paneId);

if (envFlag("SKIP_FOCUSED", true) && isFocused(snapshot, event, context)) {
  console.error(`pane is focused; skipping ${status} notification`);
  process.exit(0);
}

const debounceMs = envInt("DEBOUNCE_MS", 3000);
if (debounceMs > 0 && recentlyNotified(paneId, status, debounceMs)) {
  console.error(`debounced ${status} notification for ${paneId}`);
  process.exit(0);
}

const title = `${emojiFor(status)} ${agentLabel(snapshot, event, context)} is ${status}`;
const body = sessionLabel(snapshot, event, context);
const body2 = projectLabel(snapshot, event, context);

try {
  await sendToast({ title, body, body2, tag: paneId });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function agentSnapshot(paneId) {
  if (!paneId || paneId === "unknown") {
    return undefined;
  }
  const bins = [...new Set([process.env.HERDR_BIN_PATH, "herdr"].filter(Boolean))];
  for (const bin of bins) {
    const result = spawnSync(bin, ["agent", "get", paneId], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
      continue;
    }
    try {
      const agent = JSON.parse(result.stdout)?.result?.agent;
      if (agent && typeof agent === "object") {
        return agent;
      }
    } catch {
      // fall through to the next candidate
    }
  }
  return undefined;
}

function statusFrom(event, context) {
  const candidates = [
    event?.data?.agent_status,
    event?.data?.status,
    context.focused_pane_status,
    context.agent_status,
    context.status,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim().toLowerCase();
    }
  }
  return undefined;
}

function paneIdFrom(event, context) {
  const candidates = [
    event?.data?.pane_id,
    event?.data?.pane?.pane_id,
    context.pane_id,
    process.env.HERDR_PANE_ID,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

// Only skips when a source explicitly marks the pane as focused; when the
// field is absent everywhere we notify rather than guess.
function isFocused(snapshot, event, context) {
  const candidates = [
    snapshot?.focused,
    event?.data?.focused,
    event?.data?.pane?.focused,
    context.pane?.focused,
    context.focused,
  ];
  return candidates.some((value) => value === true);
}

function agentLabel(snapshot, event, context) {
  const raw =
    snapshot?.agent ??
    event?.data?.display_agent ??
    event?.data?.agent ??
    context.focused_pane_agent ??
    context.agent ??
    "agent";
  const text = String(raw).trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Agent";
}

function emojiFor(status) {
  if (status === "blocked") {
    return "⚠️";
  }
  if (status === "done") {
    return "✅";
  }
  return "💤";
}

// Session summary line. Claude Code (and most agents) keep the terminal title
// set to a short description of the current task, which herdr tracks as
// terminal_title_stripped.
function sessionLabel(snapshot, event, context) {
  return (
    cleanLabel(snapshot?.terminal_title_stripped) ??
    cleanLabel(event?.data?.terminal_title_stripped) ??
    cleanLabel(context.terminal_title_stripped) ??
    cleanLabel(context.tab_label)
  );
}

// Which project/workspace the agent was working in.
function projectLabel(snapshot, event, context) {
  const cwd = snapshot?.cwd ?? context.focused_pane_cwd ?? context.workspace_cwd;
  const dir = cwd ? basename(String(cwd)) : undefined;
  const workspace =
    cleanLabel(context.workspace_label) ??
    event?.data?.workspace_id ??
    context.workspace_id;
  if (dir && workspace && dir !== workspace) {
    return `📁 ${dir} (${workspace})`;
  }
  return dir ? `📁 ${dir}` : workspace ? String(workspace) : undefined;
}

// Drops empty and purely numeric labels (default tab names).
function cleanLabel(label) {
  const text = String(label ?? "").trim();
  if (!text || /^\d+$/.test(text)) {
    return undefined;
  }
  return text;
}

function recentlyNotified(paneId, status, windowMs) {
  const path = join(stateDir(), "last-notify.json");
  const key = `${paneId}:${status}`;
  const now = Date.now();

  let entries = {};
  if (existsSync(path)) {
    try {
      entries = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      entries = {};
    }
  }

  if (now - (entries[key] ?? 0) < windowMs) {
    return true;
  }

  entries[key] = now;
  for (const [entryKey, timestamp] of Object.entries(entries)) {
    if (now - timestamp > Math.max(windowMs * 10, 60_000)) {
      delete entries[entryKey];
    }
  }
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(path, JSON.stringify(entries), "utf8");
  } catch (error) {
    console.error(`failed to persist debounce state: ${error.message}`);
  }
  return false;
}
