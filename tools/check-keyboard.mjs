// Checks the ⌨️ keyboard: on Siti's page (which lifts its message box using visualViewport) and
// on a plain page that does nothing (iOS then pans the whole page up). Reads files, never writes.
//   node tools/check-keyboard.mjs [<scratch copy with web/demo/web/plain.html> on :4491]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(new URL("../build/", import.meta.url));
const { chromium } = require("playwright-core");

const ROOT = path.resolve(import.meta.dirname, "..");
const KEY = fs.readFileSync(path.join(ROOT, "data/key"), "utf8").trim();
const OUT = path.join(ROOT, "data/check"); fs.mkdirSync(OUT, { recursive: true });
const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
const exe = fs.readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().pop();
const browser = await chromium.launch({ executablePath: path.join(cache, exe, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing") });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, w) => { console.log((c ? "ok   " : "FAIL ") + w); if (!c) fails++; };

async function open(base, project, pg) {
  const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(`${base}/pair?key=${KEY}`); await page.waitForURL(`${base}/`);
  await page.goto(`${base}/?project=${project}&page=${pg}`); await sleep(2000);
  page.app = () => page.frames().find((f) => f.url().includes("/app/"));
  return page;
}
const KBTOP = 874 - 336; // where the keyboard starts on the phone's screen, in points

// 1. Siti: tap ⌨️ → keyboard drawn, her input focused, her footer lifted above the keyboard.
let page = await open("http://127.0.0.1:4490", "ai/siti", "web/index.html");
await page.click("#kbd-btn"); await sleep(1200);
ok(!(await page.locator("#kbd").isHidden()), "keyboard is drawn on the phone");
const s1 = await page.app().evaluate(() => ({
  focused: document.activeElement?.id, vvh: visualViewport.height, ih: innerHeight,
  footerBottom: document.querySelector("footer").getBoundingClientRect().bottom,
  transform: document.querySelector("footer").style.transform,
}));
console.log("     siti:", JSON.stringify(s1));
ok(s1.focused === "input", "Siti's message box is focused");
ok(s1.vvh === KBTOP && s1.ih === 874, "visualViewport shrank to the space above the keyboard; the page did not");
ok(s1.footerBottom <= KBTOP + 1, "Siti lifted her message box above the keyboard");
await page.screenshot({ path: path.join(OUT, "10-keyboard-siti.png") });
await page.click("#kbd-btn"); await sleep(600);
const s2 = await page.app().evaluate(() => ({ vvh: visualViewport.height, focused: document.activeElement?.id || "", t: document.querySelector("footer").style.transform }));
ok(await page.locator("#kbd").isHidden() && s2.vvh === 874 && s2.focused !== "input" && !s2.t, "⌨️ again puts it away and Siti drops back");
if (page.errors.length) console.log("     errors:", page.errors);
await page.context().close();

// 2. A plain page with no handling: the field would be under the keyboard, so the page pans up.
if (process.argv[2]) {
  page = await open("http://127.0.0.1:4491", "web/demo", "web/plain.html");
  await page.click("#kbd-btn"); await sleep(1200);
  const pan = await page.evaluate(() => getComputedStyle(document.getElementById("app")).transform);
  const p = await page.app().evaluate(() => ({ vvTop: visualViewport.offsetTop, inputBottom: document.querySelector("input").getBoundingClientRect().bottom }));
  console.log("     plain:", JSON.stringify(p), pan);
  ok(p.vvTop > 0 && pan.includes("matrix"), "page panned up, as iOS does");
  ok(p.inputBottom - p.vvTop <= KBTOP + 1, "field now sits just above the keyboard");
  await page.screenshot({ path: path.join(OUT, "11-keyboard-plain.png") });
  await page.context().close();
}
await browser.close();
process.exit(fails ? 1 : 0);
