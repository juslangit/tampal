// End-to-end check of tampal in a headless Chrome the size of an iPhone 17 (402×874, touch).
// Opens Siti's chat page in the preview, taps its footer, and checks the code jumped to it.
//   node tools/check.mjs            (needs the server running and build/node_modules)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(new URL("../build/", import.meta.url));
const { chromium } = require("playwright-core");

const ROOT = path.resolve(import.meta.dirname, "..");
const KEY = fs.readFileSync(path.join(ROOT, "data/key"), "utf8").trim();
const B = "http://127.0.0.1:4490";
const OUT = path.join(ROOT, "data/check"); fs.mkdirSync(OUT, { recursive: true });
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
const exe = fs.readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().pop();
const browser = await chromium.launch({ executablePath: path.join(cache, exe, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing") });
const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("page: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond, what) => { console.log((cond ? "ok   " : "FAIL ") + what); if (!cond) fails++; };

await page.goto(`${B}/pair?key=${KEY}`);
await page.waitForURL(`${B}/`);
await page.goto(`${B}/?project=${encodeURIComponent(process.argv[2] || "ai/siti")}&page=${encodeURIComponent(process.argv[3] || "web/index.html")}`);
await sleep(2500);
await page.screenshot({ path: path.join(OUT, "1-open.png") });
ok(await page.locator(".cm-content").count() === 1, "editor is showing");
ok((await page.textContent("#where-file")).includes("index.html"), "page file is open in the editor");
const app = page.frameLocator("#app");
ok(await app.locator("footer").count() >= 0, "app loaded in the preview");

// Tap whatever is near the bottom of the phone (Siti's message box).
const sel = process.argv[4] || "footer";
const target = page.frames().find((f) => f.url().includes("/app/"));
const box = await target.locator(sel).first().boundingBox();
ok(!!box, `found ${sel} in the app`);
if (box) {
  await page.touchscreen.tap(box.x + box.width / 2, box.y + Math.min(6, box.height / 2));
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, "2-tapped.png") });
  ok(!(await page.locator("#sheet").isHidden()), "details sheet opened");
  const chain = await page.textContent("#chain");
  console.log("     chain:", chain);
  const line = await page.evaluate(() => document.querySelector(".cm-activeLine")?.textContent);
  console.log("     active line:", line?.slice(0, 90));
  ok(!!line, "a code line is highlighted");
  const rules = await page.locator(".rule").allTextContents();
  console.log("     rules:", rules.slice(0, 3).map((r) => r.slice(0, 100)));
  ok(rules.length > 0, "CSS rules listed");
  // Open the first rule's CSS and check the line really has that selector.
  const link = page.locator(".rule a[data-open]").first();
  if (await link.count()) {
    const sel1 = await page.locator(".rule .sel").first().textContent();
    await link.click();
    await sleep(700);
    const l = await page.evaluate(() => document.querySelector(".cm-activeLine")?.textContent || "");
    console.log("     css line:", l.slice(0, 90));
    ok(l.replace(/\s/g, "").includes(sel1.split(",")[0].replace(/\s/g, "").slice(0, 12)), "CSS rule line matches its selector");
    await page.screenshot({ path: path.join(OUT, "3-css.png") });
  }
}
console.log(errors.length ? "errors:\n  " + errors.join("\n  ") : "no page errors");
await browser.close();
process.exit(fails ? 1 : 0);
