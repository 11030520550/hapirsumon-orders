// Screenshots of the main screens on the demo data (start-local.mjs must be running).
//   node testing/local-pg/screenshots.mjs <output folder> [--width 1440] [--reset] [--only dashboard,orders]
import { mkdirSync } from "node:fs";
import path from "node:path";
import { openBrowser } from "./cdp.mjs";

const args = process.argv.slice(2);
const outDir = path.resolve(args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) || "screenshots");
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const width = Number(opt("width", 1440));
const height = Number(opt("height", 900));
const only = opt("only", "") ? new Set(opt("only", "").split(",")) : null;
const base = `http://127.0.0.1:${opt("port", 8010)}/`;
mkdirSync(outDir, { recursive: true });

const SHOTS = [
  ["dashboard", "#/dashboard"],
  ["orders", "#/orders"],
  ["new-order", "#/new-order"],
  ["client", "#/client/c-demo-01"],
  ["clients", "#/clients"],
  ["sheets", "#/sheets"],
  ["sheet", "#/sheet/498"],
  ["packages", "#/packages"],
  ["payments", "#/payments"],
  ["reports", "#/reports"]
];

const browser = await openBrowser({ width, height });
try {
  await browser.goto(`${base}?db=demo${args.includes("--reset") ? "&seed=demo&reset=1" : ""}`);
  await browser.waitFor(`window.__localpg && ["ready", "error"].includes(window.__localpg.status.phase)`, 180000);
  const phase = await browser.evaluate("window.__localpg.status.phase + ' ' + window.__localpg.status.detail");
  if (!phase.startsWith("ready")) throw new Error(phase);
  const signedIn = await browser.evaluate(`!document.querySelector("#app-shell").hidden`);
  if (!signedIn) {
    await browser.waitFor(`document.querySelector("#login-form") && !document.querySelector("#login-form").closest("[hidden]")`, 20000);
    await browser.evaluate(`(() => { const f = document.querySelector("#login-form"); f.elements.email.value = "staff@local.test"; f.elements.password.value = "test1234"; f.requestSubmit(); return 1; })()`);
  }
  await browser.waitFor(`window.ModaatApp && window.ModaatApp.orders().length > 0 && !document.querySelector("#app-shell").hidden`, 30000);
  for (const [name, hash] of SHOTS) {
    if (only && !only.has(name)) continue;
    await browser.evaluate(`location.hash = ${JSON.stringify(hash)}; 1`);
    await new Promise((r) => setTimeout(r, 900));
    await browser.evaluate("window.scrollTo(0, 0); document.querySelector('.main-content, main')?.scrollTo?.(0, 0); 1");
    const file = path.join(outDir, `${name}-${width}.png`);
    if (args.includes("--full")) {
      const h = await browser.evaluate("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)");
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height: Math.min(h, 6000), deviceScaleFactor: 1, mobile: false });
      await new Promise((r) => setTimeout(r, 300));
      await browser.screenshot(file);
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    } else await browser.screenshot(file);
    console.log(file);
  }
  const errors = browser.consoleErrors();
  if (errors.length) console.log("console errors:", JSON.stringify(errors).slice(0, 800));
} finally {
  await browser.close();
}
