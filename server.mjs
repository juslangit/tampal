// tampal's server — Node built-ins only.
//
// It does four jobs:
//   1. serves the editor page (web/) to the iPhone or the Mac;
//   2. serves the app being edited under /app/<subject>/<project>/…, with two quiet changes
//      to its HTML and CSS so the preview can point back at the code (see instrumentHtml);
//   3. reads and saves the project's files, keeping a copy of every version in data/history;
//   4. runs the `claude` command when Luqman taps something and asks for a fix.
//
// Access: a key in data/key, handed to a browser once through /pair?key=… and kept as a
// cookie — the same arrangement as Siti. Only reachable from this Mac and over Tailscale.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const HOME = os.homedir();
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const WEB = path.join(ROOT, "web");
const DATA = path.join(ROOT, "data");
const HISTORY = path.join(DATA, "history");
const PROJECTS = process.env.TAMPAL_PROJECTS || path.join(HOME, "Desktop/projects");
const CLAUDE = [path.join(HOME, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((f) => fs.existsSync(f)) || "claude";
const PORT = Number(process.env.TAMPAL_PORT || 4490);

fs.mkdirSync(HISTORY, { recursive: true });
const KEY_FILE = path.join(DATA, "key");
if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(24).toString("base64url"), { mode: 0o600 });
const KEY = fs.readFileSync(KEY_FILE, "utf8").trim();

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- projects and files

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".cache", "data", "__pycache__", ".venv", "venv"]);
const TEXT = /\.(html?|css|m?js|json|svg|md|txt|webmanifest)$/i;

// Every folder two levels down (subject/project) that has an index.html somewhere near the top.
function listProjects() {
  const out = [];
  for (const subject of safeDir(PROJECTS)) {
    if (!subject.isDirectory() || subject.name.startsWith(".")) continue;
    for (const proj of safeDir(path.join(PROJECTS, subject.name))) {
      if (!proj.isDirectory() || proj.name.startsWith(".")) continue;
      const dir = path.join(PROJECTS, subject.name, proj.name);
      const pages = findPages(dir);
      // Only projects with a real page — a Godot game whose one HTML file is its record is not a web app.
      if (pages.some((p) => !/^(docs|legacy)\//.test(p))) out.push({ id: `${subject.name}/${proj.name}`, pages });
    }
  }
  return out.sort((a, b) => mtime(b.id) - mtime(a.id));
}
function mtime(id) { try { return fs.statSync(path.join(PROJECTS, id)).mtimeMs; } catch { return 0; } }
function safeDir(d) { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } }

// HTML pages up to two folders deep, the project's record (docs/) last since it is generated.
function findPages(dir) {
  const pages = [];
  const walk = (rel, depth) => {
    for (const e of safeDir(path.join(dir, rel))) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 2) walk(r, depth + 1);
      else if (e.isFile() && /\.html?$/i.test(e.name)) pages.push(r);
    }
  };
  walk("", 0);
  const rank = (p) => (/^(docs|legacy)\//.test(p) ? 4 : 0) + (/(^|\/)index\.html$/.test(p) ? 0 : 1) +
    (p.includes("/") && !/^(web|public|site|app|src|www)\//.test(p) ? 0.5 : 0) + p.split("/").length * 0.1;
  return pages.sort((a, b) => rank(a) - rank(b)).slice(0, 60);
}

function listFiles(dir) {
  const files = [];
  const walk = (rel, depth) => {
    for (const e of safeDir(path.join(dir, rel))) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 5) walk(r, depth + 1);
      else if (e.isFile() && TEXT.test(e.name) && files.length < 800) files.push(r);
    }
  };
  walk("", 0);
  return files.sort();
}

// A project id from the client → its folder, refusing anything that climbs out.
function projectDir(id) {
  if (!/^[\w. -]+\/[\w. -]+$/.test(id || "") || id.includes("..")) throw httpError(400, "bad project");
  const dir = path.join(PROJECTS, id);
  if (!fs.existsSync(dir)) throw httpError(404, "no such project");
  return fs.realpathSync(dir);
}
function fileIn(dir, rel) {
  const f = path.resolve(dir, rel || "");
  if (f !== dir && !f.startsWith(dir + path.sep)) throw httpError(400, "outside the project");
  if (fs.existsSync(f)) {
    const real = fs.realpathSync(f);
    if (!real.startsWith(dir + path.sep)) throw httpError(400, "outside the project");
  }
  return f;
}

// Every save keeps the version it replaced, so nothing typed on the phone is ever lost.
function keepVersion(id, rel, content) {
  const d = path.join(HISTORY, id.replace("/", "__"), rel.replaceAll("/", "__"));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${Date.now()}`), content);
  const old = fs.readdirSync(d).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 100))) fs.rmSync(path.join(d, f));
}

function search(dir, q) {
  const hits = [];
  if (!q || q.length < 2) return hits;
  for (const rel of listFiles(dir)) {
    if (!/\.(m?js|html?|css)$/i.test(rel)) continue;
    let text; try { text = fs.readFileSync(path.join(dir, rel), "utf8"); } catch { continue; }
    if (text.length > 1_500_000) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < 40; i++) {
      if (lines[i].includes(q)) hits.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 140) });
    }
  }
  return hits;
}

// ---------------------------------------------------------------- the preview's HTML and CSS

// Two changes to what the preview receives, and none to the files on disk:
//
// 1. Every start tag gets data-tampal-loc="line:col" — where it sits in the source — so a tap
//    on the preview knows which line to highlight. Inserted straight after the tag name, so
//    attributes, self-closing tags and line numbers are all left as they were.
// 2. env(safe-area-inset-*) becomes var(--tampal-safe-*). Inside an iframe the browser
//    reports every safe area as zero, which would hide exactly the edge gaps (Siti's footer,
//    2026-10-06) this tool exists to catch. The variables carry the iPhone 17's real values.
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noscript"]);
function instrumentHtml(src) {
  let out = "", i = 0, last = 0, line = 1, lineStart = 0;
  const advance = (to) => {
    for (let k = i; k < to; k++) if (src.charCodeAt(k) === 10) { line++; lineStart = k + 1; }
    i = to;
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    advance(lt);
    if (src.startsWith("<!--", i)) { const e = src.indexOf("-->", i + 4); advance(e < 0 ? src.length : e + 3); continue; }
    if (src[i + 1] === "!" || src[i + 1] === "?" || src[i + 1] === "/") { const e = src.indexOf(">", i); advance(e < 0 ? src.length : e + 1); continue; }
    const m = /^<([a-zA-Z][\w:-]*)/.exec(src.slice(i, i + 64));
    if (!m) { advance(i + 1); continue; }
    const name = m[1].toLowerCase();
    const at = i + m[0].length;
    out += src.slice(last, at) + ` data-tampal-loc="${line}:${i - lineStart + 1}"`;
    last = at;
    // Walk the attributes to the real end of the tag, stepping over quoted values.
    let k = at, q = null;
    for (; k < src.length; k++) {
      const c = src[k];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
    }
    advance(Math.min(k + 1, src.length));
    if (RAW_TEXT.has(name)) {
      const close = src.toLowerCase().indexOf(`</${name}`, i);
      advance(close < 0 ? src.length : close);
    }
  }
  out += src.slice(last);
  return out;
}

const safeVars = (s) => s.replace(/env\(\s*safe-area-inset-(top|right|bottom|left)/g, "var(--tampal-safe-$1");

// The iPhone the preview is pretending to be, set by the editor page in a cookie so that every
// page the app opens gets the same values from its very first paint.
function safeAreaStyle(req) {
  const v = (cookies(req).tampal_safe || "0,0,0,0").split(",").map((n) => Math.max(0, Math.min(200, Number(n) || 0)));
  return `<style id="tampal-safe">:root{--tampal-safe-top:${v[0]}px;--tampal-safe-right:${v[1]}px;--tampal-safe-bottom:${v[2]}px;--tampal-safe-left:${v[3]}px}</style>` +
    `<script src="/__tampal/inspector.js"></script>`;
}

function injectHead(html, extra) {
  // Straight after <head> if there is one, else before the first tag after the doctype.
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + extra + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + extra + html.slice(at);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm", ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
};

function serveApp(req, res, id, rel) {
  const dir = projectDir(id);
  let f = fileIn(dir, decodeURIComponent(rel));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) return text(res, 404, "not found");
  const ext = path.extname(f).toLowerCase();
  const head = { "content-type": TYPES[ext] || "application/octet-stream", "cache-control": "no-store" };
  if (ext === ".html" || ext === ".htm") {
    const html = injectHead(instrumentHtml(fs.readFileSync(f, "utf8")), safeAreaStyle(req));
    res.writeHead(200, head);
    return res.end(safeVars(html));
  }
  if (ext === ".css") { res.writeHead(200, head); return res.end(safeVars(fs.readFileSync(f, "utf8"))); }
  // A service worker would cache the preview and outlive every edit — give it nothing to register.
  if (/(^|\/)(sw|service-worker)\.m?js$/.test(rel)) { res.writeHead(200, head); return res.end("// tampal: service worker switched off in the preview\n"); }
  res.writeHead(200, head);
  fs.createReadStream(f).pipe(res);
}

// A root-relative path ("/style.css") from a page at a/b/index.html: the app's server probably
// serves a/b/ (Siti serves web/), so try a/b/, then a/, then the project's own top.
function serveRootPath(req, res, id, page, p) {
  if (req.method !== "GET") return json(res, 404, { error: "the preview has no server behind it" });
  const dir = projectDir(id);
  const parts = decodeURIComponent(page).split("/").slice(0, -1);
  for (let n = parts.length; n >= 0; n--) {
    const rel = [...parts.slice(0, n), p.slice(1)].filter(Boolean).join("/");
    try { if (fs.existsSync(fileIn(dir, rel))) return serveApp(req, res, id, encodeURI(rel)); } catch {}
  }
  return text(res, 404, "not found");
}

// ---------------------------------------------------------------- watching for outside changes

// When Claude, or Luqman on the Mac, changes a file, the phone's editor and preview follow.
const listeners = new Map(); // project id -> Set of SSE responses
const watchers = new Map();
const ownWrites = new Map(); // absolute path -> content we just wrote
function watch(id) {
  if (watchers.has(id)) return;
  const dir = projectDir(id);
  let timer = null; const pending = new Set();
  try {
    const w = fs.watch(dir, { recursive: true }, (_, name) => {
      if (!name || name.split(path.sep).some((p) => SKIP_DIRS.has(p) || p.startsWith("."))) return;
      pending.add(name.split(path.sep).join("/"));
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const rel of pending) {
          const abs = path.join(dir, rel);
          let now = null; try { now = fs.readFileSync(abs, "utf8"); } catch {}
          if (ownWrites.get(abs) === now) continue;
          for (const r of listeners.get(id) || []) r.write(`data: ${JSON.stringify({ type: "change", file: rel })}\n\n`);
        }
        pending.clear();
      }, 150);
    });
    watchers.set(id, w);
  } catch (e) { log("watch failed", id, e.message); }
}

// ---------------------------------------------------------------- asking Claude for a fix

const runs = new Map(); // project id -> running child
function snapshot(dir) {
  const snap = new Map();
  for (const rel of listFiles(dir)) {
    try { const st = fs.statSync(path.join(dir, rel)); if (st.size < 2_000_000) snap.set(rel, fs.readFileSync(path.join(dir, rel), "utf8")); } catch {}
  }
  return snap;
}
const undoable = new Map(); // project id -> Map(rel -> content before Claude's last change)

function ask(res, id, body) {
  const dir = projectDir(id);
  if (runs.has(id)) return json(res, 409, { error: "Claude is already working on this project" });
  const before = snapshot(dir);
  const prompt = [
    `You are helping Luqman fix a small front-end detail in the web app in this folder (${id}).`,
    `He is looking at it in tampal, a preview that shows the page as it appears on an iPhone 17: ${body.device || "402×874pt"}.`,
    `In that preview, env(safe-area-inset-*) is replaced with var(--tampal-safe-*) — that is only the preview; edit the real env() values in the source as usual.`,
    "",
    "He tapped this element:",
    body.context || "(no element selected)",
    "",
    `What he wants: ${String(body.prompt || "").slice(0, 2000)}`,
    "",
    "Make the smallest change that does exactly that, in the source files, and nothing else — no refactoring, no reformatting, no other fixes.",
    "Prefer changing CSS over HTML when either would do. Keep the existing code style.",
    "Then reply in one or two short plain-English sentences: what you changed and where (file:line), with the old and new values.",
  ].join("\n");
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose",
    // Restricted: no shell and no web, file tools confined to this project, edits only.
    "--restricted", "--tools", "Read,Edit,Glob,Grep", "--permission-mode", "acceptEdits"];
  const child = spawn(CLAUDE, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${path.join(HOME, ".local/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } });
  runs.set(id, child);
  log("ask", id, JSON.stringify(String(body.prompt).slice(0, 80)));
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
  const send = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch {} };
  send({ type: "step", text: "Reading the code…" });
  let buf = "", result = "", err = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === "assistant") {
        for (const c of m.message?.content || []) {
          if (c.type === "tool_use") {
            const f = c.input?.file_path ? path.relative(dir, c.input.file_path) : c.input?.pattern || "";
            send({ type: "step", text: `${{ Read: "Reading", Edit: "Editing", Glob: "Looking for", Grep: "Searching for" }[c.name] || c.name} ${f}` });
          }
        }
      }
      if (m.type === "result") result = m.result || m.error || "";
    }
  });
  child.stderr.on("data", (d) => { err += d; });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 5 * 60_000);
  child.on("close", (code) => {
    clearTimeout(timeout);
    runs.delete(id);
    const after = snapshot(dir);
    const changed = [];
    const prev = new Map();
    for (const [rel, content] of after) if (before.get(rel) !== content) { changed.push(rel); prev.set(rel, before.get(rel) ?? null); }
    for (const rel of changed) if (before.has(rel)) keepVersion(id, rel, before.get(rel));
    if (changed.length) undoable.set(id, prev);
    send({ type: "done", text: result || (code ? `Claude stopped (${code}). ${err.slice(-300)}` : "Done."), changed, ok: code === 0 });
    res.end();
  });
  res.on("close", () => {}); // the run carries on if the phone locks; the change still lands on disk
}

function undoClaude(id) {
  const dir = projectDir(id);
  const prev = undoable.get(id);
  if (!prev) throw httpError(404, "nothing to undo");
  for (const [rel, content] of prev) {
    const f = fileIn(dir, rel);
    if (content === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, content);
  }
  undoable.delete(id);
  return [...prev.keys()];
}

// ---------------------------------------------------------------- http plumbing

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function json(res, status, o) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); }
function text(res, status, s) { res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }); res.end(s); }
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((p) => p.trim().split("=")).filter((p) => p.length === 2));
}
function same(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function readBody(req, limit = 5_000_000) {
  return new Promise((ok, bad) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > limit) { bad(httpError(413, "too big")); req.destroy(); } });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(httpError(400, "bad json")); } });
  });
}
// DNS rebinding: a page on evil.com that resolves to 127.0.0.1 still sends its own Host.
function hostAllowed(req) {
  const h = (req.headers.host || "").replace(/:\d+$/, "");
  return h === "127.0.0.1" || h === "localhost" || h.endsWith(".ts.net");
}
function serveStatic(res, f) {
  if (!fs.existsSync(f)) return text(res, 404, "not found");
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(f).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (!hostAllowed(req)) return json(res, 403, { error: "unknown host" });
  const https = (req.headers.host || "").includes(".ts.net");

  if (p === "/pair") {
    if (!same(url.searchParams.get("key") || "", KEY)) return json(res, 403, { error: "wrong key" });
    res.writeHead(200, {
      "set-cookie": `tampal=${KEY}; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000${https ? "; Secure" : ""}`,
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
    });
    return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
      `<body style="background:#16171d"><script>location.replace("/")</script>`);
  }
  if (req.method === "GET" && (p === "/manifest.json" || p === "/icon.png") && !/\/app\//.test(req.headers.referer || "")) return serveStatic(res, path.join(WEB, p.slice(1)));
  if (!same(cookies(req).tampal || "", KEY)) {
    if (p === "/") return serveStatic(res, path.join(WEB, "locked.html"));
    return json(res, 401, { error: "this browser is not paired with tampal" });
  }
  if (req.method !== "GET") {
    let from = null; try { from = new URL(req.headers.origin).host; } catch {}
    if (from !== req.headers.host) return json(res, 403, { error: "wrong origin" });
  }

  try {
    if (p === "/__tampal/inspector.js") return serveStatic(res, path.join(WEB, "inspector.js"));
    // An app that asks for "/style.css" or "/api/…" means its own root, not tampal's.
    const ref = /\/app\/([^/]+\/[^/]+)\/([^?#]*)/.exec(req.headers.referer || "");
    if (ref && !p.startsWith("/app/")) return serveRootPath(req, res, decodeURIComponent(ref[1]), ref[2], p);
    if (p === "/") return serveStatic(res, path.join(WEB, "index.html"));
    if (req.method === "GET" && /^\/(vendor\/)?[\w.-]+\.(js|css)$/.test(p)) return serveStatic(res, path.join(WEB, p.slice(1)));

    // /app/<subject>/<project>/<file…> — the app itself, as the preview sees it.
    const app = /^\/app\/([^/]+\/[^/]+)\/(.*)$/.exec(p);
    if (app && req.method === "GET") return serveApp(req, res, decodeURIComponent(app[1]), app[2]);

    if (p === "/api/projects") return json(res, 200, { projects: listProjects() });
    const id = url.searchParams.get("project");
    if (p === "/api/files") return json(res, 200, { files: listFiles(projectDir(id)), pages: findPages(projectDir(id)) });
    if (p === "/api/search") return json(res, 200, { hits: search(projectDir(id), url.searchParams.get("q")) });
    if (p === "/api/file" && req.method === "GET") {
      const f = fileIn(projectDir(id), url.searchParams.get("path"));
      if (!fs.existsSync(f)) throw httpError(404, "no such file");
      return json(res, 200, { content: fs.readFileSync(f, "utf8"), mtime: fs.statSync(f).mtimeMs });
    }
    if (p === "/api/file" && req.method === "PUT") {
      const body = await readBody(req);
      const rel = url.searchParams.get("path");
      const f = fileIn(projectDir(id), rel);
      if (!TEXT.test(f)) throw httpError(400, "only text files");
      const old = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
      // Someone else (Claude, or the Mac) changed it since the phone loaded it: say so rather than overwrite.
      if (old !== null && body.base != null && Math.abs(fs.statSync(f).mtimeMs - body.base) > 1 && old !== body.content && !body.force) {
        return json(res, 409, { error: "changed elsewhere", content: old, mtime: fs.statSync(f).mtimeMs });
      }
      if (old !== null && old !== body.content) keepVersion(id, rel, old);
      ownWrites.set(f, body.content);
      fs.writeFileSync(f, body.content);
      return json(res, 200, { mtime: fs.statSync(f).mtimeMs });
    }
    if (p === "/api/events") {
      projectDir(id); watch(id);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": hi\n\n");
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => { clearInterval(ping); listeners.get(id)?.delete(res); });
      return;
    }
    if (p === "/api/ask" && req.method === "POST") return ask(res, id, await readBody(req));
    if (p === "/api/ask/stop" && req.method === "POST") { runs.get(id)?.kill("SIGTERM"); return json(res, 200, { ok: true }); }
    if (p === "/api/ask/undo" && req.method === "POST") return json(res, 200, { files: undoClaude(id) });

    return text(res, 404, "not found");
  } catch (e) {
    if (!e.status) log("error", p, e.stack);
    if (!res.headersSent) json(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => log(`tampal listening on http://127.0.0.1:${PORT}`));
