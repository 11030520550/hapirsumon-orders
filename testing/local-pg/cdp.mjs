// Minimal Chrome DevTools Protocol driver (Node 22: built-in fetch and WebSocket). Real clock, no virtual time:
// virtual time freezes the database clock (see testing/postgres/README.md).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHROME = [
  process.env.CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].find((p) => p && existsSync(p));

export async function openBrowser({ width = 1440, height = 1000, port = 9300 + Math.floor(Math.random() * 500) } = {}) {
  if (!CHROME) throw new Error("Chrome (or Edge) was not found; set CHROME=<path to chrome.exe>");
  const profile = mkdtempSync(path.join(tmpdir(), "hps-cdp-"));
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 100 && !target; i += 1) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch { }
    if (!target) await new Promise((r) => setTimeout(r, 150));
  }
  if (!target) { proc.kill(); throw new Error("Chrome did not start"); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    send, evaluate, events,
    async goto(url) { await send("Page.navigate", { url }); },
    async waitFor(expression, timeoutMs = 120000, every = 250) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        let v; try { v = await evaluate(expression); } catch { v = undefined; }
        if (v) return v;
        if (Date.now() > end) throw new Error(`timeout waiting for: ${expression}`);
        await new Promise((r) => setTimeout(r, every));
      }
    },
    async screenshot(file) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    consoleErrors() {
      return events.filter((e) => (e.method === "Runtime.exceptionThrown") || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error"))
        .map((e) => e.method === "Runtime.exceptionThrown" ? (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
          : e.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    },
    async close() { try { await send("Browser.close"); } catch { } proc.kill(); await new Promise((r) => setTimeout(r, 300)); try { rmSync(profile, { recursive: true, force: true }); } catch { } }
  };
}
