// Runs testing/local-pg/e2e.html in headless Chrome against a running start-local.mjs and prints the result.
//   node testing/local-pg/start-local.mjs      (in one window)
//   node testing/local-pg/run-e2e.mjs [--port 8010]
// Exit code 0 = RESULT OK.
import { openBrowser } from "./cdp.mjs";

const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 8010;
const browser = await openBrowser({ width: 1600, height: 1000 });
let result = "";
try {
  await browser.goto(`http://127.0.0.1:${port}/__local/e2e.html`);
  result = await browser.waitFor(`document.getElementById("out")?.textContent.endsWith("DONE") && document.getElementById("out").textContent`, 600000, 500);
} catch (error) {
  result = `ERROR ${error.message}\n` + (await browser.evaluate(`document.getElementById("out")?.textContent || ""`).catch(() => ""));
} finally {
  await browser.close();
}
console.log(result);
process.exit(result.startsWith("RESULT OK") ? 0 : 1);
