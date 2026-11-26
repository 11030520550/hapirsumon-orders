// Design Studio — a tiny static server with no dependencies.
// Serves the repository root read-only, so the studio can use the project's fonts and photographs.
// Usage (from the repository root):  node design-studio/serve.mjs [port]
// Then open:                          http://127.0.0.1:8020/design-studio/
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.argv[2]) || 8020;
const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".md": "text/plain; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
};
// Only these folders are served: the studio itself and the project's assets (fonts, photographs, logo).
const allowed = [`${sep}design-studio${sep}`, `${sep}assets${sep}`];

createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/" || path === "/design-studio") { res.writeHead(302, { Location: "/design-studio/" }).end(); return; }
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(root, path));
    const rel = file.slice(root.length);
    if (!file.startsWith(root + sep) || !allowed.some((a) => rel.startsWith(a))) { res.writeHead(404).end("Not found"); return; }
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Design Studio: http://127.0.0.1:${port}/design-studio/`);
});
