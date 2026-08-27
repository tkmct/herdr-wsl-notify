import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const DEFAULT_POWERSHELL =
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

// AppUserModelID of Windows PowerShell. Toasts need a registered AppId; we
// borrow this one so no registry setup is required. Override with TOAST_APP_ID.
const DEFAULT_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const TIMEOUT_MS = 10_000;

export function isWsl() {
  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

export function findPowershell() {
  const override = process.env.POWERSHELL_EXE?.trim();
  if (override) {
    if (existsSync(override)) {
      return override;
    }
    console.error(`POWERSHELL_EXE not found: ${override}`);
    return undefined;
  }
  if (existsSync(DEFAULT_POWERSHELL)) {
    return DEFAULT_POWERSHELL;
  }
  // Fall back to PATH resolution; spawn reports an error if it is missing too.
  return "powershell.exe";
}

// Escapes every XML special character including both quote styles, so the
// result is also safe inside a single-quoted PowerShell string literal.
function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function psSingleQuote(value) {
  return String(value).replace(/'/g, "''");
}

// Tag is limited to short identifiers on older Windows builds.
function sanitizeTag(value) {
  return String(value).replace(/[^\w:.-]/g, "_").slice(0, 60);
}

export function sendToast({ title, body, body2, tag, group = "herdr" }) {
  const powershell = findPowershell();
  if (!powershell) {
    return Promise.reject(
      new Error("powershell.exe not found; is WSL interop enabled?"),
    );
  }

  const appId = process.env.TOAST_APP_ID?.trim() || DEFAULT_APP_ID;
  const texts = [title, body, body2]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== "")
    .map((value) => `<text>${escapeXml(value)}</text>`)
    .join("");
  const xml = `<toast><visual><binding template="ToastGeneric">${texts}</binding></visual></toast>`;

  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml('${psSingleQuote(xml)}')`,
    "$toast = New-Object Windows.UI.Notifications.ToastNotification($xml)",
    ...(tag
      ? [
          `$toast.Tag = '${psSingleQuote(sanitizeTag(tag))}'`,
          `$toast.Group = '${psSingleQuote(sanitizeTag(group))}'`,
        ]
      : []),
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${psSingleQuote(appId)}').Show($toast)`,
  ].join("\n");

  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    const child = spawn(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encoded,
      ],
      {
        // A Windows cwd avoids the UNC-path warning when launched from a WSL path.
        cwd: existsSync("/mnt/c") ? "/mnt/c" : undefined,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`powershell.exe timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(`powershell.exe exited ${code}${detail ? `: ${detail}` : ""}`),
        );
      }
    });
  });
}
