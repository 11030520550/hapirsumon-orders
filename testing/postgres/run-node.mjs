// Runs pg-runner.html's test script under Node (no browser, no server), for machines that have Node.
// The script runs unchanged; only the PGlite import path and fetch() (file reads from the repo) are adapted.
// Usage, from the repository root:  node testing/postgres/run-node.mjs
// Exit code 0 = RESULT OK, 1 = a check failed or errored.
import { readFile, writeFile, rm, mkdtemp } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = await readFile(path.join(repo, "testing/postgres/pg-runner.html"), "utf8");
const pglite = pathToFileURL(path.join(repo, "testing/postgres/package/dist/index.js")).href;
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace('"/__test/package/dist/index.js"', JSON.stringify(pglite))
  .replaceAll("window.fetch", "globalThis.fetch")
  .replaceAll("bind(window)", "bind(globalThis)");

const out = { textContent: "" };
globalThis.document = { getElementById: () => out };
globalThis.fetch = async (input) => {
  const name = String((input && input.url) || input);
  try { return new Response(await readFile(path.join(repo, name.replace(/^\//, "")), "utf8"), { status: 200 }); }
  catch { return new Response("Not found", { status: 404 }); }
};

const dir = await mkdtemp(path.join(tmpdir(), "pg-runner-"));
const file = path.join(dir, "pg-runner.mjs");
try {
  await writeFile(file, script);
  await import(pathToFileURL(file).href);
  while (!out.textContent.endsWith("DONE")) await new Promise((r) => setTimeout(r, 200));
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(out.textContent);
process.exit(out.textContent.startsWith("RESULT OK") ? 0 : 1);
