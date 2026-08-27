import { loadDotEnv, modeEnabled, setMode } from "./lib.mjs";
import { isWsl, sendToast } from "./toast.mjs";

loadDotEnv();

const arg = (process.argv[2] ?? "").trim().toLowerCase();
const enabled = arg === "on" ? true : arg === "off" ? false : !modeEnabled();
setMode(enabled);

const message = `Windows notifications ${enabled ? "enabled" : "disabled"}`;
console.log(`herdr-wsl-notify: ${message}`);

// Best-effort confirmation toast so a keybinding toggle has visible feedback.
if (isWsl()) {
  try {
    await sendToast({
      title: `${enabled ? "🔔" : "🔕"} Herdr`,
      body: message,
      tag: "toggle",
    });
  } catch (error) {
    console.error(error.message);
  }
}
