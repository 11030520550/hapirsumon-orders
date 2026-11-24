// LOCAL TEST VERSION: the real site (index.html, app.js, business-app.js, styles.css) against a real PostgreSQL
// (PGlite) in the browser, built from the project's SQL files, with test data only. No Supabase, no production.
//
//   node testing/local-pg/start-local.mjs [--port 8010]
//   then open http://127.0.0.1:8010/   (sign in: staff@local.test / test1234)
//
// Listens on 127.0.0.1 only. Serves an allowlist: the site files, the root supabase-*.sql files and the
// test tools. No CSP is sent here (PGlite needs WebAssembly); the production CSP is tested by the Mock runners.
import http from "node:http";
import { readFile, stat, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const pgliteDir = path.join(root, "testing", "postgres", "package");
const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 8010;

// The PGlite version the SQL tests were run with, and its npm integrity hash.
const PGLITE = {
  version: "0.5.17",
  tarball: "https://registry.npmjs.org/@electric-sql/pglite/-/pglite-0.5.17.tgz",
  integrity: "sha512-8SvKjiUjaU+0O0dbxjOfN+jXz14TEqDWbwDkYOW1aQ11y/ph2JvFVI27ABBo5nfw+ZfSqy4hKCNlbnbB1TDE+g=="
};

async function ensurePglite() {
  if (existsSync(path.join(pgliteDir, "dist", "index.js"))) return;
  console.log(`PGlite ${PGLITE.version} is not here yet: downloading it once from npm…`);
  const response = await fetch(PGLITE.tarball);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (got !== PGLITE.integrity) throw new Error("the downloaded PGlite does not match its npm integrity hash; nothing was installed");
  const file = path.join(tmpdir(), `pglite-${PGLITE.version}-${process.pid}.tgz`);
  await writeFile(file, bytes);
  const tar = process.platform === "win32" && existsSync("C:\\Windows\\System32\\tar.exe") ? "C:\\Windows\\System32\\tar.exe" : "tar";
  await mkdir(path.dirname(pgliteDir), { recursive: true });
  const result = spawnSync(tar, ["-xzf", file, "-C", path.dirname(pgliteDir)], { stdio: "inherit" });
  await rm(file, { force: true });
  if (result.status !== 0 || !existsSync(path.join(pgliteDir, "dist", "index.js"))) throw new Error("extracting PGlite failed");
  console.log("PGlite installed (integrity verified).");
}

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".sql": "text/plain; charset=utf-8",
  ".wasm": "application/wasm", ".data": "application/octet-stream", ".txt": "text/plain; charset=utf-8" };
const SITE_FILES = new Set(["styles.css", "app.js", "business-app.js", "business-preview.js", "supabase-config.js"]);

function resolve(p) {
  if (p.includes("..") || /(^|\/)\./.test(p)) return null;
  if (p.startsWith("/__local/package/")) return path.join(pgliteDir, p.slice("/__local/package/".length));
  if (p.startsWith("/__local/")) return path.join(here, p.slice("/__local/".length));
  const name = p.slice(1);
  if (SITE_FILES.has(name) || /^supabase-[a-z0-9-]+\.sql$/.test(name) || /^(assets|vendor)\/[A-Za-z0-9._-]+$/.test(name)) return path.join(root, name);
  return null;
}

// --supabase-test: the real site with the real supabase-js against a separate Supabase TEST project. The address
// and the publishable key come from testing/supabase-test-config.json (git-ignored); the production project is refused.
const PRODUCTION_REF = "sndaeogseawtwzwxiqst";
const supabaseTest = process.argv.includes("--supabase-test") ? await loadTestConfig() : null;
async function loadTestConfig() {
  const file = path.join(root, "testing", "supabase-test-config.json");
  let config;
  try { config = JSON.parse(await readFile(file, "utf8")); }
  catch { console.error(`--supabase-test: copy testing/supabase-test-config.example.json to testing/supabase-test-config.json and fill in the TEST project (see testing/supabase-test/README.md).`); process.exit(1); }
  const ref = String(config.projectRef || "");
  const url = String(config.url || "");
  const key = String(config.publishableKey || "");
  if (config.environment !== "test" || !/^[a-z0-9]{10,}$/.test(ref) || url !== `https://${ref}.supabase.co` || !key || /REPLACE/.test(`${ref}${url}${key}`)) {
    console.error("--supabase-test: testing/supabase-test-config.json is incomplete (environment \"test\", projectRef, url https://<ref>.supabase.co, publishableKey)."); process.exit(1);
  }
  if (ref === PRODUCTION_REF || url.includes(PRODUCTION_REF)) { console.error("--supabase-test: this is the PRODUCTION project. Refused."); process.exit(1); }
  if (/service_role|sb_secret/i.test(key) || /^eyJ/.test(key) && JSON.parse(Buffer.from(key.split(".")[1] || "", "base64url").toString() || "{}").role === "service_role") {
    console.error("--supabase-test: that is a secret key. Only the publishable (anon) key belongs here."); process.exit(1);
  }
  return { ref, url, key };
}

async function indexPage() {
  let html = await readFile(path.join(root, "index.html"), "utf8");
  if (supabaseTest) {
    // Real site, real supabase-js (with its SRI hash); only the config file is the test project's, plus a notice.
    html = html.replace('<script src="supabase-config.js"></script>', '<script src="/__local/test-config.js"></script><script src="/__local/test-notice.js" defer></script>');
    return Buffer.from(html.replace(/(src|href)="(?!https?:|\/|#|data:)/g, '$1="/'), "utf8");
  }
  // The only change: the Supabase library is replaced by the local PostgreSQL client. Cache versions are dropped.
  html = html.replace(/<script src="vendor\/supabase-js-[^"]+"[^>]*><\/script>/, '<script src="/__local/pg-supabase.js"></script>');
  html = html.replace(/(src|href)="([a-z-]+\.(?:js|css))\?v=[^"]*"/g, '$1="/$2"').replace(/(src|href)="(?!https?:|\/|#|data:)/g, '$1="/');
  return Buffer.from(html, "utf8");
}

await ensurePglite();
http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, "http://local").pathname);
    let body, type;
    if (p === "/" || p === "/index.html") { body = await indexPage(); type = types[".html"]; }
    else if (supabaseTest && p === "/__local/test-config.js") {
      body = Buffer.from(`"use strict";\nwindow.MODAAT_SUPABASE_CONFIG = Object.freeze(${JSON.stringify({ url: supabaseTest.url, publishableKey: supabaseTest.key })});\n`); type = types[".js"];
    } else if (supabaseTest && p === "/__local/test-notice.js") {
      body = Buffer.from(`"use strict";\n(function () { const bar = document.createElement("div"); bar.setAttribute("role", "status"); bar.textContent = ${JSON.stringify(`פרויקט הבדיקות של Supabase (${supabaseTest.ref}) · לא הייצור · נתוני בדיקה בלבד`)}; bar.style.cssText = "position:fixed;inset:auto 0 0 0;z-index:99999;padding:5px 12px;background:#1f4f7a;color:#fff;font:13px/1.4 system-ui,sans-serif;text-align:center;direction:rtl"; document.body.append(bar); })();\n`); type = types[".js"];
    }
    else {
      const file = resolve(p);
      const ext = file ? path.extname(file).toLowerCase() : "";
      if (!file || !types[ext] || !(await stat(file)).isFile()) throw new Error("not found");
      body = await readFile(file); type = types[ext];
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : "Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log("");
  if (supabaseTest) {
    console.log(`  The real site against the Supabase TEST project ${supabaseTest.ref} (not production)`);
    console.log(`  Open:     http://127.0.0.1:${port}/   (sign in with the test project's approved test user)`);
    console.log("  Stop:     Ctrl+C");
    console.log("");
    return;
  }
  console.log("  Local demo version (fictional data only, not Supabase, not production)");
  console.log(`  Open:     http://127.0.0.1:${port}/`);
  console.log("  Sign in:  staff@local.test / test1234   (not approved: pending@local.test / test1234)");
  console.log(`  E2E run:  http://127.0.0.1:${port}/__local/e2e.html`);
  console.log("  Stop:     Ctrl+C");
  console.log("");
});
