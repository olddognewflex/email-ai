import { spawn } from "node:child_process";

/** Fire-and-forget `open <url>`; spawn failures are swallowed. */
export function openExternal(url: string): void {
  const child = spawn("open", [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {
    // Swallow spawn failures; the status line already reported the attempt.
  });
  child.unref();
}

/**
 * `open <url>`, resolving once `open` exits 0 (macOS accepted the URL) and
 * rejecting if it cannot be spawned, exits non-zero, or hangs.
 */
export function openExternalChecked(url: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      // Don't leave a hung `open` running after we've given up on it.
      child.kill();
      settle(new Error("timed out opening the link"));
    }, timeoutMs);
    const child = spawn("open", [url], { detached: true, stdio: "ignore" });
    child.on("error", (err) => settle(err));
    child.on("exit", (code, signal) => {
      if (code === 0) settle();
      else settle(new Error(`open exited with ${signal ?? `code ${code}`}`));
    });
    child.unref();
  });
}

/** Only open http(s) links from untrusted email content. */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
