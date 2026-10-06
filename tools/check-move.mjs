// Checks drag-to-move and the nudge arrows against a throwaway copy of a project.
//   TAMPAL_PROJECTS=<scratch> TAMPAL_PORT=4491 node server.mjs &   then
//   node tools/check-move.mjs <scratch>
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(new URL("../build/", import.meta.url));
const { chromium } = require("playwright-core");

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRATCH = process.argv[2];
const CSS = path.join(SCRATCH, "web/demo/web/style.css");
const HTML = path.join(SCRATCH, "web/demo/web/index.html");
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
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, w) => { console.log((c ? "ok   " : "FAIL ") + w); if (!c) fails++; };
const app = () => page.frames().find((f) => f.url().includes("/app/"));
const rect = (sel) => app().evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y }; }, sel);
const block = (sel) => { const t = fs.readFileSync(CSS, "utf8"); const i = t.indexOf(sel + " {"); return t.slice(i, t.indexOf("}", i) + 1); };

// A finger drag, through CDP (Playwright's touchscreen only taps).
const cdp = await ctx.newCDPSession(page);
async function drag(x, y, dx, dy) {
  const pt = (px, py) => [{ x: px, y: py, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(x, y) });
  for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(x + dx * i / 8, y + dy * i / 8) }); await sleep(16); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
// The preview is scaled: screen points per app pixel.
const scale = async () => page.evaluate(() => new DOMMatrix(getComputedStyle(document.getElementById("device")).transform).a);

await page.goto(`${B}/pair?key=${KEY}`); await page.waitForURL(`${B}/`);
await page.goto(`${B}/?project=web/demo&page=web/index.html`); await sleep(2000);
// The preview is scaled and moves when the details sheet opens: measure it every time.
let s = 1, frameBox = null;
const measure = async () => { s = await scale(); frameBox = await page.locator("#app").boundingBox(); };
const toScreen = (p) => ({ x: frameBox.x + p.x * s, y: frameBox.y + p.y * s });
await measure();

// 1. Select the message box (#composer has its own rule), then drag it 20 right, 30 up.
const c0 = await rect("#composer");
let p = toScreen({ x: c0.x + 120, y: c0.y + 10 });
await page.touchscreen.tap(p.x, p.y); await sleep(800);
// the tap lands on the textarea inside; walk up to the form
for (let i = 0; i < 3 && !(await page.textContent("#chain")).trim().endsWith("form#composer"); i++) { await page.click("#sel-parent"); await sleep(300); }
ok((await page.textContent("#chain")).trim().endsWith("form#composer"), "selected the message box");
await sleep(400); await measure();
p = toScreen({ x: c0.x + 120, y: c0.y + 10 });
await drag(p.x, p.y, 20 * s, -30 * s);
await sleep(1800);
console.log("     toast:", await page.textContent("#toast"), "| hidden:", await page.locator("#toast").isHidden());
const b1 = block("#composer");
console.log("     " + b1.replace(/\n/g, "\n     "));
ok(/position: relative;/.test(b1) && /left: 20px;/.test(b1) && /top: -30px;/.test(b1), "drag wrote position/left/top into #composer");
const c1 = await rect("#composer");
ok(Math.round(c1.x - c0.x) === 20 && Math.round(c1.y - c0.y) === -30, `message box really moved (${Math.round(c1.x - c0.x)}, ${Math.round(c1.y - c0.y)})`);
await page.screenshot({ path: path.join(OUT, "8-moved.png") });

// 2. Nudge right twice and up once — quick taps, before each save lands.
await page.click("#nudge-right"); await page.click("#nudge-right"); await page.click("#nudge-up");
await sleep(2000);
console.log("     toast:", await page.textContent("#toast"));
const b2 = block("#composer");
ok(/left: 22px;/.test(b2) && /top: -31px;/.test(b2), "nudges added up (left 22, top -31)");
const c2 = await rect("#composer");
ok(Math.round(c2.x - c0.x) === 22 && Math.round(c2.y - c0.y) === -31, `and the preview agrees (${Math.round(c2.x - c0.x)}, ${Math.round(c2.y - c0.y)})`);

// 3. Undo in the editor puts the rule back.
for (let i = 0; i < 6; i++) { await page.click("#undo"); await sleep(150); }
await sleep(1500);
ok(!/left:/.test(block("#composer")), "undo took the move out again");

// 4. A one-line rule that matches only it (#empty h2) gets the properties added neatly.
async function dragAt(find, dy) {
  const at = await app().evaluate(find);
  let q = toScreen(at);
  await page.touchscreen.tap(q.x, q.y); await sleep(800);
  await measure(); q = toScreen(at);
  await drag(q.x, q.y, 0, dy * s); await sleep(2200);
  console.log("     toast:", await page.textContent("#toast"));
}
await dragAt(() => { const r = document.querySelector("#empty h2").getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; }, 15);
const h2 = fs.readFileSync(CSS, "utf8").split("\n").find((l) => l.startsWith("#empty h2"));
console.log("     " + h2);
ok(h2 === "#empty h2 { margin: 0 0 4px; font-size: 22px; position: relative; top: 15px; }", "one-line rule edited neatly");

const sharedBefore = block(".suggest button");
// 5. One of three buttons sharing `.suggest button`: the move goes into style="" on its own tag.
await dragAt(() => { const r = document.querySelector(".suggest button").getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; }, 10);
const line = fs.readFileSync(HTML, "utf8").split("\n").find((l) => l.includes("Test a game"));
console.log("     " + line.trim().slice(0, 140));
ok(/style="position: relative; top: 10px"/.test(line), "shared-rule element got its own style=\"\"");
ok(block(".suggest button") === sharedBefore, "the shared .suggest button rule was left alone");
await page.screenshot({ path: path.join(OUT, "9-moved-button.png") });
console.log(errors.length ? "errors:\n  " + errors.join("\n  ") : "no page errors");
await browser.close();
process.exit(fails ? 1 : 0);
