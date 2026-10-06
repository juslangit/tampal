// Checks typing, live save, CSS hot-swap, outside changes and "Ask Claude" against a throwaway
// copy of a project — never a real one.
//   TAMPAL_PROJECTS=<scratch> TAMPAL_PORT=4491 node server.mjs &   then
//   node tools/check-edit.mjs <scratch> [--claude]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(new URL("../build/", import.meta.url));
const { chromium } = require("playwright-core");

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRATCH = process.argv[2];
const CSS = path.join(SCRATCH, "web/demo/web/style.css");
const KEY = fs.readFileSync(path.join(ROOT, "data/key"), "utf8").trim();
const B = "http://127.0.0.1:4491";
const OUT = path.join(ROOT, "data/check"); fs.mkdirSync(OUT, { recursive: true });
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
const exe = fs.readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().pop();
const browser = await chromium.launch({ executablePath: path.join(cache, exe, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing") });
const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, w) => { console.log((c ? "ok   " : "FAIL ") + w); if (!c) fails++; };
const appFrame = () => page.frames().find((f) => f.url().includes("/app/"));
const footerPad = () => appFrame().evaluate(() => getComputedStyle(document.querySelector("footer")).paddingTop);

await page.goto(`${B}/pair?key=${KEY}`); await page.waitForURL(`${B}/`);
await page.goto(`${B}/?project=web/demo&page=web/index.html`); await sleep(2000);

// Tap the footer's own padding strip (above the composer), then jump to its CSS rule.
const fb = await appFrame().locator("footer").boundingBox();
await page.touchscreen.tap(fb.x + fb.width / 2, fb.y + 1.5);
await sleep(1000);
ok((await page.textContent("#chain")).trim().endsWith("footer"), "tapped the footer");
await page.locator(".rule a[data-open]").first().click(); await sleep(600);
ok((await page.textContent("#where-file")).includes("style.css"), "style.css opened from the rule");
ok((await page.evaluate(() => document.querySelector(".cm-activeLine")?.textContent || "")).startsWith("footer"), "cursor on the footer rule");

// Type a change: padding 8px → 30px, the way a thumb would (select "8px" and type).
const before = await footerPad();
await page.evaluate(() => {
  const v = window.__tampalView;
  const line = v.state.doc.lineAt(v.state.selection.main.head);
  const at = line.from + line.text.indexOf("8px");
  v.dispatch({ selection: { anchor: at, head: at + 3 } });
  v.focus();
});
await page.keyboard.type("30px");
await sleep(1800);
ok(fs.readFileSync(CSS, "utf8").includes("footer { padding: 30px"), "saved to disk");
ok((await footerPad()) === "30px" && before !== "30px", `preview updated without a reload (${before} → ${await footerPad()})`);
await page.screenshot({ path: path.join(OUT, "4-edited.png") });

// Undo button puts it back, and that saves too.
await page.click("#undo"); await sleep(1800);
console.log("     after undo:", await page.evaluate(() => { const v = window.__tampalView; return v.state.doc.lineAt(v.state.selection.main.head).text.slice(0, 40) + " | save: " + document.getElementById("save").title; }));
ok(fs.readFileSync(CSS, "utf8").includes("footer { padding: 8px"), "undo saved the old value back");

// A change made outside (as Claude or the Mac would) shows up in the editor and preview.
fs.writeFileSync(CSS, fs.readFileSync(CSS, "utf8").replace("footer { padding: 8px", "footer { padding: 14px"));
await sleep(1500);
ok((await page.evaluate(() => window.__tampalView.state.doc.toString())).includes("footer { padding: 14px"), "outside change reached the editor");
ok((await footerPad()) === "14px", "outside change reached the preview");
fs.writeFileSync(CSS, fs.readFileSync(CSS, "utf8").replace("footer { padding: 14px", "footer { padding: 8px"));
await sleep(1200);

if (process.argv.includes("--claude")) {
  await page.touchscreen.tap(fb.x + fb.width / 2, fb.y + 1.5); await sleep(800);
  await page.fill("#ask-text", "make the space above the message box 20px instead of 8px");
  await page.click("#ask-send");
  const t0 = Date.now();
  await page.waitForSelector("#ask-log .actions", { timeout: 240_000 });
  console.log(`     Claude took ${Math.round((Date.now() - t0) / 1000)}s: ${(await page.textContent("#ask-log")).slice(0, 300)}`);
  await sleep(1500);
  ok(/footer\s*\{\s*padding:\s*20px/.test(fs.readFileSync(CSS, "utf8")), "Claude changed the CSS on disk");
  ok((await footerPad()) === "20px", "Claude's change reached the preview");
  await page.screenshot({ path: path.join(OUT, "5-claude.png") });
  if (await page.locator("#ask-undo").count()) {
    await page.click("#ask-undo"); await sleep(1500);
    ok(fs.readFileSync(CSS, "utf8").includes("footer { padding: 8px"), "Undo Claude's change put it back");
  }
}
console.log(errors.length ? "errors:\n  " + errors.join("\n  ") : "no page errors");
await browser.close();
process.exit(fails ? 1 : 0);
