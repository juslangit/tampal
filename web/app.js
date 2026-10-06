// tampal — the editor page. Code on the left (CodeMirror), the app on the right inside an
// iPhone 17, and a sheet at the bottom for whatever was tapped. Taps in the app arrive as
// messages from inspector.js; everything on disk goes through server.mjs.
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, Decoration,
  EditorState, StateField, StateEffect, Compartment, history, historyKeymap, defaultKeymap, indentWithTab, undo, redo,
  syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, searchKeymap, highlightSelectionMatches,
  closeBrackets, html, css, javascript, oneDark,
} from "./vendor/cm.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("tampal." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("tampal." + k, JSON.stringify(v)); } catch {} },
};

// ------------------------------------------------------------------ state
const S = {
  project: null,        // "web/kasih-alza"
  files: [], pages: [],
  page: null,           // the HTML file shown in the preview, relative to the project
  file: null,           // the file open in the editor
  docs: new Map(),      // file -> { state, mtime, saved }
  meta: null,           // what the previewed page asks of the phone (viewport, status bar…)
  selection: null,      // the last thing tapped, as inspector.js described it
  inspecting: store.get("inspect", true),
  mode: store.get("mode", "app"),
  zoom: store.get("zoom", "fit"),
  font: store.get("font", 11),
  wrap: store.get("wrap", true),
  keepY: null,          // scroll to restore after a reload
  reselect: null,       // element to select again after a reload
};
const api = async (p, opts = {}) => {
  const r = await fetch(p, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(body.error || r.statusText); e.status = r.status; e.body = body; throw e; }
  return body;
};
const q = (o) => new URLSearchParams(o).toString();
let toastTimer;
function toast(t, ms = 2200) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), ms); }

// The page's height follows the iPhone keyboard, so the code you are typing stays in view.
function fitViewport() {
  const h = window.visualViewport ? visualViewport.height : innerHeight;
  document.documentElement.style.setProperty("--vh", h + "px");
  window.scrollTo(0, 0);
  layoutDevice();
}
window.visualViewport?.addEventListener("resize", fitViewport);
addEventListener("resize", fitViewport);

// ------------------------------------------------------------------ the editor
const lang = new Compartment(), wrapping = new Compartment(), sizing = new Compartment();
const flash = StateEffect.define();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(flash)) {
      if (!e.value) return Decoration.none;
      const { from, to } = e.value;
      const marks = [];
      const doc = tr.state.doc;
      for (let l = doc.lineAt(from).number; l <= doc.lineAt(Math.min(to, doc.length)).number; l++) {
        marks.push(Decoration.line({ class: "cm-tampal-mark" }).range(doc.line(l).from));
      }
      return Decoration.set(marks);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
const fontTheme = (px) => EditorView.theme({
  "&": { fontSize: px + "px" },
  ".cm-content": { fontFamily: "var(--mono)", padding: "4px 0" },
  ".cm-gutters": { fontSize: (px - 1) + "px", minWidth: "0" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 3px 0 2px", minWidth: "20px" },
  ".cm-line": { padding: "0 4px 0 2px" },
});
const langFor = (f) => /\.css$/i.test(f) ? css() : /\.m?js$|\.json$/i.test(f) ? javascript() : html();

let fromPreview = false; // a selection made because of a tap — don't echo it back to the preview
const extensions = (file) => [
  lineNumbers(), highlightActiveLineGutter(), history(), drawSelection(), indentOnInput(), bracketMatching(), closeBrackets(),
  highlightActiveLine(), highlightSelectionMatches(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark,
  keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
  lang.of(langFor(file)), wrapping.of(S.wrap ? EditorView.lineWrapping : []), sizing.of(fontTheme(S.font)), flashField,
  EditorView.contentAttributes.of({ autocapitalize: "off", autocorrect: "off", spellcheck: "false" }),
  EditorView.updateListener.of((u) => {
    if (u.docChanged && u.transactions.some((t) => t.isUserEvent("input") || t.isUserEvent("delete") || t.isUserEvent("undo") || t.isUserEvent("redo") || t.isUserEvent("move") || t.isUserEvent("paste"))) scheduleSave();
    if (u.selectionSet && !fromPreview && u.transactions.some((t) => t.isUserEvent("select"))) cursorMoved();
    updateUndo();
  }),
];
const view = new EditorView({ parent: $("editor"), state: EditorState.create({ doc: "", extensions: extensions("x.html") }) });
window.__tampalView = view; // for tools/check-edit.mjs

function updateUndo() {
  $("undo").disabled = !S.file; $("redo").disabled = !S.file;
}
$("undo").onclick = () => { undo(view); view.focus(); };
$("redo").onclick = () => { redo(view); view.focus(); };

async function openFile(file, { line, col, endPos, focus } = {}) {
  if (!file) return;
  if (S.file !== file) {
    if (S.file) { await flushSave(); S.docs.get(S.file) && (S.docs.get(S.file).state = view.state); }
    let d = S.docs.get(file);
    if (!d) {
      const r = await api(`/api/file?${q({ project: S.project, path: file })}`);
      d = { state: EditorState.create({ doc: r.content, extensions: extensions(file) }), mtime: r.mtime, saved: r.content };
      S.docs.set(file, d);
    }
    S.file = file;
    view.setState(d.state);
    $("code-empty").hidden = true;
    $("where-file").textContent = file + (file === S.page ? "  · in the app" : "");
    store.set("file:" + S.project, file);
  }
  if (line) {
    const doc = view.state.doc;
    const L = doc.line(Math.max(1, Math.min(line, doc.lines)));
    const from = Math.min(L.from + Math.max(0, (col || 1) - 1), L.to);
    const to = endPos != null ? endPos : L.to;
    fromPreview = true;
    view.dispatch({ selection: { anchor: from, head: Math.min(to, doc.length) }, effects: [flash.of({ from, to }), EditorView.scrollIntoView(from, { y: "center" })] });
    fromPreview = false;
    if (focus) view.focus();
  }
  updateUndo();
}

// The end of an HTML start tag that begins at `from`, stepping over quoted attribute values.
function tagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length && i < from + 4000; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i + 1;
  }
  return from;
}

// ------------------------------------------------------------------ saving
let saveTimer = null, saving = null;
function setSave(state, title) { const el = $("save"); el.className = "save " + (state || ""); el.title = title || "Saved"; }
function scheduleSave() {
  setSave("dirty", "Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 650);
}
async function flushSave() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await save(); } else if (saving) await saving; }
async function save(force = false) {
  saveTimer = null;
  const file = S.file, d = S.docs.get(file);
  if (!d) return;
  const content = view.state.doc.toString();
  if (content === d.saved) { setSave(); return; }
  saving = (async () => {
    try {
      const r = await api(`/api/file?${q({ project: S.project, path: file })}`, { method: "PUT", body: JSON.stringify({ content, base: d.mtime, force }) });
      d.mtime = r.mtime; d.saved = content; d.state = view.state;
      setSave();
      hideBanner();
      afterChange(file);
    } catch (e) {
      if (e.status === 409) {
        setSave("error", "Changed somewhere else");
        banner(`${file} was changed somewhere else (Claude, or the Mac).`, [
          ["Use that version", () => { replaceDoc(file, e.body.content, e.body.mtime); hideBanner(); }],
          ["Keep mine", () => { save(true); }],
        ]);
      } else { setSave("error", "Not saved: " + e.message); toast("Not saved: " + e.message); }
    } finally { saving = null; }
  })();
  return saving;
}
function replaceDoc(file, content, mtime) {
  const d = S.docs.get(file);
  if (!d) return;
  if (S.file === file) {
    const old = view.state.doc.toString();
    if (old !== content) {
      // Change only the middle that differs, so the cursor and the undo history survive.
      let a = 0; while (a < old.length && a < content.length && old[a] === content[a]) a++;
      let b = 0; while (b < old.length - a && b < content.length - a && old[old.length - 1 - b] === content[content.length - 1 - b]) b++;
      view.dispatch({ changes: { from: a, to: old.length - b, insert: content.slice(a, content.length - b) } });
    }
    d.state = view.state;
  } else d.state = EditorState.create({ doc: content, extensions: extensions(file) });
  d.saved = content; d.mtime = mtime;
  setSave();
}

function banner(text, actions = []) {
  const b = $("banner"); b.innerHTML = ""; b.hidden = false;
  const s = document.createElement("span"); s.textContent = text; b.appendChild(s);
  for (const [t, fn] of actions) { const x = document.createElement("button"); x.textContent = t; x.onclick = fn; b.appendChild(x); }
}
function hideBanner() { $("banner").hidden = true; }

// After a file changes on disk: CSS is swapped into the running app; anything else reloads it.
const frame = $("app");
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const appPrefix = () => `/app/${enc(S.project)}/`;
const appUrl = (rel) => appPrefix() + enc(rel);
function afterChange(file) {
  cssCache.delete(file);
  if (/\.css$/i.test(file)) {
    const parts = file.split("/");
    const alt = parts.map((_, i) => "/" + parts.slice(i).join("/"));   // "/style.css" for web/style.css
    send({ type: "css", path: appUrl(file), alt });
  } else if (/\.(html?|m?js|json|svg)$/i.test(file)) reloadApp();
}

// ------------------------------------------------------------------ the preview
function send(msg) { try { frame.contentWindow.postMessage({ tampal: true, ...msg }, location.origin); } catch {} }
function reloadApp(keep = true) {
  if (!S.page) return;
  if (keep) { S.reselect = S.selection?.where?.exact ? S.selection.where.loc : null; }
  try { frame.contentWindow.location.reload(); } catch { frame.src = appUrl(S.page); }
}

// iPhone 17: 402 × 874 points. Status bar and Dynamic Island take the top 62, the home bar the
// bottom 34. What the page gets depends on how it asks: viewport-fit=cover lets it draw edge to
// edge and see those numbers as safe-area insets; black-translucent puts it under the status bar.
const PHONE = { w: 402, h: 874, top: 62, bottom: 34 };
function geometry() {
  const m = S.meta || {};
  const cover = /viewport-fit\s*=\s*cover/i.test(m.viewport || "");
  const translucent = /black-translucent/i.test(m.statusBar || "");
  if (S.mode === "safari") {
    // Safari's toolbar floats over the page; the status bar area is Safari's own.
    return { top: PHONE.top, height: PHONE.h - PHONE.top, safe: [0, 0, cover ? PHONE.bottom : 0, 0], overStatus: false };
  }
  if (cover && translucent) return { top: 0, height: PHONE.h, safe: [PHONE.top, 0, PHONE.bottom, 0], overStatus: true };
  if (cover) return { top: PHONE.top, height: PHONE.h - PHONE.top, safe: [0, 0, PHONE.bottom, 0], overStatus: false };
  return { top: PHONE.top, height: PHONE.h - PHONE.top - PHONE.bottom, safe: [0, 0, 0, 0], overStatus: false };
}
function applyGeometry() {
  const g = geometry();
  frame.style.top = g.top + "px";
  frame.style.height = g.height + "px";
  const cookie = g.safe.join(",");
  const changed = cookie !== store.get("safe", null);
  document.cookie = `tampal_safe=${cookie}; path=/; SameSite=Strict`;
  store.set("safe", cookie);
  $("device").classList.toggle("safari", S.mode === "safari");
  // The status bar's colours: over the page (light text), or on its own band in the page colour.
  const m = S.meta || {};
  const bg = m.themeColor || m.background || "#ffffff";
  const sb = $("statusbar");
  sb.style.background = g.overStatus ? "transparent" : bg;
  sb.style.color = g.overStatus ? (/black-translucent/.test(m.statusBar || "") ? "#fff" : dark(bg) ? "#fff" : "#000") : (dark(bg) ? "#fff" : "#000");
  $("page-bg").style.background = m.background && !/rgba\(0, 0, 0, 0\)/.test(m.background) ? m.background : "#fff";
  $("homebar").style.background = dark(m.background || "#fff") ? "rgba(255,255,255,.75)" : "rgba(0,0,0,.8)";
  return changed;
}
function dark(color) {
  const c = document.createElement("canvas").getContext("2d");
  c.fillStyle = "#fff"; c.fillStyle = color || "#fff";
  const hex = c.fillStyle;
  let r, g, b;
  if (hex.startsWith("#")) { r = parseInt(hex.slice(1, 3), 16); g = parseInt(hex.slice(3, 5), 16); b = parseInt(hex.slice(5, 7), 16); }
  else { [r, g, b] = (hex.match(/[\d.]+/g) || [255, 255, 255]).map(Number); }
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

function layoutDevice() {
  const pane = $("preview-pane"), dev = $("device");
  const W = pane.clientWidth, H = pane.clientHeight, DW = 426, DH = 898, pad = 6;
  let s = Math.min((W - pad * 2) / DW, (H - pad * 2) / DH);
  if (S.zoom === "width") s = (W - pad * 2) / DW;
  if (S.zoom === "1") s = 1;
  s = Math.max(0.1, s);
  dev.style.transform = `scale(${s})`;
  const w = DW * s, h = DH * s;
  dev.style.left = Math.max(pad, (W - w) / 2) + "px";
  dev.style.top = Math.max(pad, (H - h) / 2) + "px";
  // Let the stage scroll when the phone is bigger than the pane.
  let spacer = $("stage-spacer");
  if (!spacer) { spacer = document.createElement("div"); spacer.id = "stage-spacer"; spacer.style.cssText = "position:absolute;width:1px;height:1px;pointer-events:none"; $("stage").appendChild(spacer); }
  spacer.style.left = (Math.max(pad, (W - w) / 2) + w + pad - 1) + "px";
  spacer.style.top = (Math.max(pad, (H - h) / 2) + h + pad - 1) + "px";
}

function showPage(rel) {
  S.page = rel;
  store.set("page:" + S.project, rel);
  $("preview-empty").hidden = true;
  // Read the page's own <meta> tags first, so the phone is the right shape from the first paint.
  api(`/api/file?${q({ project: S.project, path: rel })}`).then((r) => {
    const meta = (n) => new RegExp(`<meta[^>]+name=["']${n}["'][^>]*content=["']([^"']*)`, "i").exec(r.content)?.[1] ||
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*name=["']${n}["']`, "i").exec(r.content)?.[1] || "";
    S.meta = { viewport: meta("viewport"), statusBar: meta("apple-mobile-web-app-status-bar-style"), themeColor: meta("theme-color"), background: "" };
  }).catch(() => { S.meta = {}; }).finally(() => {
    applyGeometry();
    S.selection = null; renderSheet();
    frame.src = appUrl(rel);
  });
}

// ------------------------------------------------------------------ messages from the app
addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data?.tampal || e.source !== frame.contentWindow) return;
  const m = e.data;
  if (m.type === "page") {
    send({ type: "inspect", on: S.inspecting });
    const rel = decodeURIComponent(m.path.replace(appPrefix(), ""));
    if (rel && rel !== S.page && S.pages.includes(rel)) { S.page = rel; $("where-file").textContent = (S.file || "") + (S.file === rel ? "  · in the app" : ""); }
    const before = JSON.stringify(geometry());
    S.meta = { viewport: m.viewport, statusBar: m.statusBar, themeColor: m.themeColor, background: m.background };
    const geoChanged = before !== JSON.stringify(geometry());
    const cookieChanged = applyGeometry();
    if (geoChanged && cookieChanged) { reloadApp(); return; }     // the app opened a page that asks for a different shape
    if (S.keepY != null) { send({ type: "scroll", y: S.keepY }); S.keepY = null; }
    if (S.reselect) { send({ type: "reselect", loc: S.reselect }); S.reselect = null; }
  }
  if (m.type === "leaving") S.keepY = m.y;
  if (m.type === "select") onSelect(m, true);
  if (m.type === "revealed") onSelect(m, false);
  if (m.type === "updated") { m.jsHits = S.selection?.jsHits; onSelect(m, false); }
  if (m.type === "css-swapped" && !m.ok) reloadApp();
  if (m.type === "app-error") toast("App error: " + m.text, 4000);
});

async function onSelect(info, jump) {
  S.selection = info;
  $("sheet").hidden = false;
  renderSheet();
  setTimeout(layoutDevice, 220);
  if (!jump) return;
  const w = info.where;
  if (w?.exact) {
    // Written in the page's HTML: highlight the whole start tag.
    const [line, col] = w.loc.split(":").map(Number);
    await openFile(S.page);
    const doc = view.state.doc;
    const L = doc.line(Math.min(line, doc.lines));
    const from = Math.min(L.from + col - 1, L.to);
    await openFile(S.page, { line, col, endPos: tagEnd(doc.toString(), from) });
  } else {
    // Made by JavaScript: look for its id or classes in the code.
    const hits = await findInJs(info);
    S.selection.jsHits = hits;
    renderSheet();
    if (hits[0]) await openFile(hits[0].file, { line: hits[0].line });
    else if (w) { const [line, col] = w.loc.split(":").map(Number); await openFile(S.page, { line, col }); }
  }
  renderRules();
}

async function findInJs(info) {
  const needles = [];
  if (info.id) needles.push(info.id);
  needles.push(...[...info.classes].sort((a, b) => b.length - a.length));
  const seen = new Set(), hits = [];
  for (const n of needles.slice(0, 4)) {
    if (n.length < 2) continue;
    const r = await api(`/api/search?${q({ project: S.project, q: n })}`).catch(() => ({ hits: [] }));
    for (const h of r.hits) {
      if (!/\.m?js$|\.html?$/.test(h.file) || /\.css$/.test(h.file)) continue;
      // In HTML, only lines inside <script> are interesting — the markup would have had a loc.
      const key = h.file + ":" + h.line;
      if (seen.has(key)) continue;
      seen.add(key); hits.push({ ...h, needle: n });
    }
    if (hits.length >= 6) break;
  }
  return hits.sort((a, b) => (/\.m?js$/.test(b.file) - /\.m?js$/.test(a.file)));
}

// From the code: the cursor moved onto a tag in the page's HTML — show that element in the app.
let revealTimer;
function cursorMoved() {
  if (S.file !== S.page) return;
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    const pos = view.state.selection.main.head;
    const text = view.state.doc.toString();
    const lt = text.lastIndexOf("<", pos);
    if (lt < 0 || text[lt + 1] === "/" || text[lt + 1] === "!") return;
    const L = view.state.doc.lineAt(lt);
    send({ type: "reveal", loc: `${L.number}:${lt - L.from + 1}`, line: L.number });
  }, 250);
}

// ------------------------------------------------------------------ the sheet
const f1 = (n) => (Math.round(n * 10) / 10).toString();
function renderSheet() {
  const s = S.selection;
  if (!s) { $("sheet").hidden = true; return; }
  $("chain").innerHTML = s.chain.map((c, i) => i === s.chain.length - 1 ? `<b>${esc(c)}</b>` : esc(c)).join(" › ");
  requestAnimationFrame(() => { $("chain").scrollLeft = 1e6; });
  const b = s.box;
  const four = (a) => a.every((v) => v === a[0]) ? f1(a[0]) : a.map(f1).join(" ");
  $("boxline").innerHTML =
    `<span><i style="background:var(--content)"></i>${s.size[0]}×${s.size[1]}</span>` +
    `<span><i style="background:var(--margin)"></i>margin ${four(b.margin)}</span>` +
    `<span><i style="background:var(--padding)"></i>padding ${four(b.padding)}</span>` +
    (b.gap && b.gap !== "0 0" && b.gap !== "0px 0px" ? `<span><i style="background:var(--gap)"></i>gap ${esc(b.gap.split(" ")[0] === b.gap.split(" ")[1] ? b.gap.split(" ")[0] : b.gap)}</span>` : "") +
    (b.border.some((v) => v) ? `<span>border ${four(b.border)}</span>` : "") +
    `<span style="color:var(--dim)">${esc(b.display)}${b.position !== "static" ? " · " + esc(b.position) : ""}</span>` +
    (b.flex ? `<span style="color:var(--dim)">${esc(b.flex)}</span>` : "");
  const w = s.where;
  let src = "";
  if (w?.exact) src = `In the HTML: <a href="#" data-open="${esc(S.page)}" data-line="${w.loc.split(":")[0]}">${esc(S.page)}:${w.loc.split(":")[0]}</a>`;
  else {
    src = "Made by JavaScript, not written in the HTML.";
    for (const h of s.jsHits || []) src += `<span class="js">“${esc(h.needle)}” in <a href="#" data-open="${esc(h.file)}" data-line="${h.line}">${esc(h.file)}:${h.line}</a></span>`;
    if (w) src += `<span class="js">Inside ${esc(w.from)} — <a href="#" data-open="${esc(S.page)}" data-line="${w.loc.split(":")[0]}">${esc(S.page)}:${w.loc.split(":")[0]}</a></span>`;
  }
  $("source").innerHTML = src;
  renderRules();
}
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// CSS rules → file and line. The browser knows which rules apply but not where they were
// written; this reads the same file the same way (same order, @media included) to find out.
const cssCache = new Map(); // file -> [{ selector, line }]
function parseCss(text, lineOffset = 0) {
  const rules = [];
  let i = 0, line = 1, prelude = "", preludeLine = 0;
  const stack = [];          // "group" for @media and friends, whose insides are rules
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") line++;
    if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2; for (let k = i; k < end; k++) if (text[k] === "\n") line++; i = end; continue; }
    if (c === '"' || c === "'") { let k = i + 1; while (k < n && text[k] !== c) { if (text[k] === "\\") k++; if (text[k] === "\n") line++; k++; } prelude += text.slice(i, k + 1); i = k + 1; continue; }
    if (c === "{") {
      const p = prelude.trim();
      if (/^@(media|supports|container|layer|document|scope)\b/i.test(p)) stack.push("group");
      else if (p.startsWith("@")) { i = skipBlock(i); prelude = ""; continue; }       // @font-face, @keyframes…
      else { rules.push({ selector: p, line: preludeLine + lineOffset }); i = skipBlock(i); prelude = ""; continue; }
      prelude = ""; i++; continue;
    }
    if (c === "}") { stack.pop(); prelude = ""; i++; continue; }
    if (c === ";") { prelude = ""; i++; continue; }
    if (!prelude.trim() && !/\s/.test(c)) preludeLine = line;
    prelude += c; i++;
  }
  return rules;
  function skipBlock(start) {
    let depth = 0, k = start;
    for (; k < n; k++) {
      const ch = text[k];
      if (ch === "\n") line++;
      else if (ch === "/" && text[k + 1] === "*") { const e = text.indexOf("*/", k + 2); const end = e < 0 ? n : e + 2; for (let j = k; j < end; j++) if (text[j] === "\n") line++; k = end - 1; }
      else if (ch === '"' || ch === "'") { let j = k + 1; while (j < n && text[j] !== ch) { if (text[j] === "\\") j++; j++; } k = j; }
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) return k + 1; }
    }
    return n;
  }
}
async function cssRulesOf(file) {
  if (cssCache.has(file)) return cssCache.get(file);
  const text = S.docs.get(file)?.saved ?? (await api(`/api/file?${q({ project: S.project, path: file })}`)).content;
  const rules = parseCss(text);
  cssCache.set(file, rules);
  return rules;
}
async function inlineRules(loc) {
  // A <style> block inside the page: parse from just after its start tag.
  const key = S.page + "#" + loc;
  if (cssCache.has(key)) return cssCache.get(key);
  const text = S.docs.get(S.page)?.saved ?? (await api(`/api/file?${q({ project: S.project, path: S.page })}`)).content;
  const lines = text.split("\n");
  const [line, col] = loc.split(":").map(Number);
  let off = 0; for (let k = 0; k < line - 1; k++) off += lines[k].length + 1;
  const start = tagEnd(text, off + col - 1);
  const end = text.toLowerCase().indexOf("</style", start);
  const before = text.slice(0, start).split("\n").length - 1;
  const rules = parseCss(text.slice(start, end < 0 ? text.length : end), before);
  cssCache.set(key, rules);
  return rules;
}
// "/app/web/x/web/style.css" or a root-relative "/style.css" → "web/style.css"
function fileForHref(href) {
  const prefix = appPrefix();
  if (href.startsWith(prefix)) return decodeURIComponent(href.slice(prefix.length));
  const parts = S.page.split("/").slice(0, -1);
  for (let k = parts.length; k >= 0; k--) {
    const rel = [...parts.slice(0, k), decodeURIComponent(href.slice(1))].filter(Boolean).join("/");
    if (S.files.includes(rel)) return rel;
  }
  return null;
}
const squash = (s) => s.replace(/\s+/g, "").replace(/"/g, "'").toLowerCase();

let rulesToken = 0;
async function renderRules() {
  const s = S.selection, token = ++rulesToken;
  if (!s) return;
  const out = [];
  const seen = new Set();
  const BOX = /^(margin|padding|gap|row-gap|column-gap|height|min-height|max-height|width|top|bottom|inset|line-height)/;
  for (const r of s.rules) {
    let file = null, line = null;
    try {
      if (r.href) { file = fileForHref(r.href); if (file) { const list = await cssRulesOf(file); line = pick(list, r)?.line; } }
      else if (r.inline) { file = S.page; const list = await inlineRules(r.inline); line = pick(list, r)?.line; }
      else if (r.inlineAttr && s.where?.exact) { file = S.page; line = Number(s.where.loc.split(":")[0]); }
    } catch {}
    if (token !== rulesToken) return;
    // Later declarations of the same property win; mark the ones a later rule overrides.
    const decls = r.decls.map((d) => {
      const prop = d.split(":")[0].trim();
      const lost = seen.has(prop);
      seen.add(prop);
      return `<div class="decl${BOX.test(prop) ? " box" : ""}"${lost ? ' style="text-decoration:line-through;opacity:.6"' : ""}>${esc(d)};</div>`;
    }).join("");
    out.push(`<div class="rule${r.pseudo ? " overridden" : ""}"><div class="top"><span class="sel">${esc(r.selector)}${r.pseudo ? " <small>(::before/::after)</small>" : ""}</span>` +
      (file && line ? `<a href="#" data-open="${esc(file)}" data-line="${line}">${esc(file.split("/").pop())}:${line}</a>` : file ? `<span>${esc(file.split("/").pop())}</span>` : "") + `</div>` +
      (r.media ? `<div class="media">@media ${esc(r.media)}</div>` : "") + decls + `</div>`);
  }
  $("rules").innerHTML = out.join("") || `<div class="rule">No CSS rules — only the browser's defaults.</div>`;
}
function pick(list, r) {
  const at = list[r.index];
  if (at && squash(at.selector) === squash(r.selector)) return at;
  return list.find((x) => squash(x.selector) === squash(r.selector)) || at;
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-open]");
  if (!a) return;
  e.preventDefault();
  const file = a.dataset.open, line = Number(a.dataset.line);
  openFile(file, { line }).then(() => {
    // For a CSS rule, select the whole rule so it is plain what to change.
    if (/\.css$/.test(file)) {
      const doc = view.state.doc, from = doc.line(line).from, text = doc.toString();
      const close = text.indexOf("}", from);
      if (close > 0) view.dispatch({ selection: { anchor: close + 1, head: from }, effects: [flash.of({ from, to: close + 1 }), EditorView.scrollIntoView(from, { y: "center" })] });
    }
  });
});

$("sheet-handle").onclick = () => { $("sheet").classList.toggle("collapsed"); setTimeout(layoutDevice, 220); };
$("sel-parent").onclick = () => send({ type: "parent" });
$("sel-child").onclick = () => send({ type: "child" });
$("sel-clear").onclick = () => { send({ type: "clear" }); S.selection = null; renderSheet(); view.dispatch({ effects: flash.of(null) }); setTimeout(layoutDevice, 50); };

// ------------------------------------------------------------------ asking Claude
const askText = $("ask-text");
askText.addEventListener("input", () => { askText.style.height = "auto"; askText.style.height = askText.scrollHeight + "px"; });
askText.addEventListener("focus", () => $("sheet").classList.remove("collapsed"));
askText.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) askClaude(); });
$("ask-send").onclick = askClaude;

function describeSelection() {
  const s = S.selection;
  if (!s) return "";
  const b = s.box, w = s.where;
  const where = w?.exact ? `${S.page}:${w.loc}` : `made by JavaScript${s.jsHits?.length ? " — see " + s.jsHits.slice(0, 3).map((h) => `${h.file}:${h.line}`).join(", ") : ""}${w ? `; inside ${w.from} at ${S.page}:${w.loc}` : ""}`;
  const rules = [...$("rules").querySelectorAll(".rule")].map((el) => {
    const a = el.querySelector("a[data-open]");
    return `  ${a ? `${a.dataset.open}:${a.dataset.line}` : "?"}  ${el.querySelector(".sel")?.textContent || ""} { ${[...el.querySelectorAll(".decl")].map((d) => d.textContent).join(" ")} }`;
  });
  return [
    `Element: ${s.label}  (${where})`,
    `Path: ${s.chain.join(" > ")}`,
    `On screen: ${s.size[0]}×${s.size[1]} at x=${s.at[0]}, y=${s.at[1]}`,
    `Box: margin ${b.margin.join(" ")} · padding ${b.padding.join(" ")} · border ${b.border.join(" ")}${b.gap ? ` · gap ${b.gap}` : ""} · display ${b.display}${b.flex ? ` (${b.flex})` : ""}`,
    `HTML (as rendered): ${s.outer}`,
    "CSS rules that apply, the winning one first:",
    ...rules,
  ].join("\n");
}

async function askClaude() {
  const prompt = askText.value.trim();
  if (!prompt) { askText.focus(); return; }
  await flushSave();
  // Measure it again first: the boxes and rules may have changed since the tap.
  if (S.selection) { send({ type: "refresh" }); await new Promise((r) => setTimeout(r, 350)); await renderRules(); }
  const g = geometry();
  const logEl = $("ask-log");
  logEl.hidden = false; logEl.innerHTML = `<div class="step">Asking Claude…</div>`;
  $("ask-send").disabled = true; askText.blur();
  const device = `402×874pt, shown as a ${S.mode === "app" ? "Home Screen app" : "Safari tab"}; the page gets ${g.height}pt of height starting ${g.top}pt from the top; safe-area insets top ${g.safe[0]}, bottom ${g.safe[2]}`;
  try {
    const r = await fetch(`/api/ask?${q({ project: S.project })}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, context: describeSelection(), device, page: S.page }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
        if (m.type === "step") logEl.innerHTML = `<div class="step">${esc(m.text)}…</div>`;
        if (m.type === "done") {
          logEl.innerHTML = `<div>${esc(m.text)}</div>` + (m.changed?.length
            ? `<div class="step">Changed: ${m.changed.map(esc).join(", ")}</div><div class="actions"><button class="chip" id="ask-undo">Undo Claude's change</button><button class="chip" id="ask-hide">OK</button></div>`
            : `<div class="actions"><button class="chip" id="ask-hide">OK</button></div>`);
          if (m.changed?.length) { askText.value = ""; askText.style.height = "auto"; }
          $("ask-hide").onclick = () => (logEl.hidden = true);
          if ($("ask-undo")) $("ask-undo").onclick = async () => {
            const u = await api(`/api/ask/undo?${q({ project: S.project })}`, { method: "POST" }).catch((e) => toast(e.message));
            if (u) { logEl.innerHTML = `<div class="step">Put back: ${u.files.map(esc).join(", ")}</div>`; }
          };
        }
      }
    }
  } catch (e) { logEl.innerHTML = `<div style="color:var(--bad)">${esc(e.message)}</div>`; }
  $("ask-send").disabled = false;
}

// ------------------------------------------------------------------ changes from outside
let events = null;
function listen() {
  events?.close();
  events = new EventSource(`/api/events?${q({ project: S.project })}`);
  events.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.type !== "change") return;
    const file = m.file;
    if (!S.files.includes(file)) S.files.push(file);
    const d = S.docs.get(file);
    if (d) {
      const r = await api(`/api/file?${q({ project: S.project, path: file })}`).catch(() => null);
      if (!r) return;
      const mine = S.file === file ? view.state.doc.toString() : d.state.doc.toString();
      if (mine !== d.saved && mine !== r.content) {
        banner(`${file} was changed somewhere else while you were typing.`, [
          ["Use that version", () => { replaceDoc(file, r.content, r.mtime); hideBanner(); }],
          ["Keep mine", () => { d.mtime = r.mtime; save(true); hideBanner(); }],
        ]);
      } else replaceDoc(file, r.content, r.mtime);
    }
    afterChange(file);
    setTimeout(() => S.selection && send({ type: "refresh" }), 400);
  };
}

// ------------------------------------------------------------------ choosing a project and file
const picker = { mode: "projects", items: [] };
async function openPicker(mode) {
  picker.mode = mode;
  $("picker").hidden = false;
  $("picker-search").value = "";
  $("picker-list").innerHTML = `<div class="empty" style="position:static">Loading…</div>`;
  if (mode === "projects") picker.items = (await api("/api/projects")).projects;
  renderPicker();
}
function renderPicker() {
  const term = $("picker-search").value.trim().toLowerCase();
  const list = $("picker-list");
  const match = (s) => !term || s.toLowerCase().includes(term);
  let h = "";
  if (picker.mode === "projects") {
    h += `<h5>Projects with a web page</h5>`;
    for (const p of picker.items.filter((p) => match(p.id))) {
      h += `<button data-project="${esc(p.id)}" class="${p.id === S.project ? "current" : ""}">${esc(p.id.split("/")[1])}<small>${esc(p.id.split("/")[0])} · ${esc(p.pages[0])}</small></button>`;
    }
  } else {
    h += `<button data-switch="projects"><b>← Change project</b><small>${esc(S.project)}</small></button>`;
    h += `<h5>Page shown in the app</h5>`;
    for (const p of S.pages.filter(match)) h += `<button data-page="${esc(p)}" class="${p === S.page ? "current" : ""}">${esc(p)}</button>`;
    h += `<h5>Files</h5>`;
    for (const f of S.files.filter(match).filter((f) => /\.(html?|css|m?js|json|svg|webmanifest)$/i.test(f))) {
      h += `<button data-file="${esc(f)}" class="${f === S.file ? "current" : ""}">${esc(f)}</button>`;
    }
  }
  list.innerHTML = h;
}
$("picker-search").addEventListener("input", renderPicker);
$("picker-close").onclick = () => ($("picker").hidden = true);
$("picker").addEventListener("click", (e) => { if (e.target.id === "picker") $("picker").hidden = true; });
$("picker-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.switch) return openPicker("projects");
  if (b.dataset.project) { $("picker").hidden = true; return loadProject(b.dataset.project); }
  if (b.dataset.page) { $("picker").hidden = true; showPage(b.dataset.page); return openFile(b.dataset.page); }
  if (b.dataset.file) { $("picker").hidden = true; return openFile(b.dataset.file); }
});
$("where").onclick = () => openPicker(S.project ? "files" : "projects");

async function loadProject(id, { page, file } = {}) {
  await flushSave();
  const r = await api(`/api/files?${q({ project: id })}`);
  S.project = id; S.files = r.files; S.pages = r.pages; S.docs.clear(); S.file = null; cssCache.clear();
  store.set("project", id);
  $("where-project").textContent = id.split("/")[1];
  document.title = `tampal · ${id.split("/")[1]}`;
  const pg = page && r.pages.includes(page) ? page : store.get("page:" + id, null);
  const startPage = pg && r.pages.includes(pg) ? pg : r.pages[0];
  showPage(startPage);
  const f = file || store.get("file:" + id, null);
  await openFile(f && r.files.includes(f) ? f : startPage);
  listen();
}

// ------------------------------------------------------------------ toolbar, menu, divider
function setInspect(on) {
  S.inspecting = on; store.set("inspect", on);
  $("inspect").classList.toggle("on", on);
  send({ type: "inspect", on });
  toast(on ? "Tap anything in the app to find its code" : "The app works normally now — tap 🎯 to point again", 1800);
}
$("inspect").onclick = () => setInspect(!S.inspecting);
$("inspect").classList.toggle("on", S.inspecting);
$("more").onclick = () => { $("menu").hidden = false; syncMenu(); };
$("menu-close").onclick = () => ($("menu").hidden = true);
$("menu").addEventListener("click", (e) => { if (e.target.id === "menu") $("menu").hidden = true; });
$("reload").onclick = () => { $("menu").hidden = true; reloadApp(); };
function syncMenu() {
  for (const [id, v] of [["seg-mode", S.mode], ["seg-zoom", S.zoom], ["seg-wrap", S.wrap ? "1" : "0"]]) {
    for (const b of $(id).children) b.classList.toggle("on", b.dataset.v === v);
  }
}
$("seg-mode").onclick = (e) => { const v = e.target.dataset.v; if (!v) return; S.mode = v; store.set("mode", v); syncMenu(); applyGeometry(); reloadApp(); };
$("seg-zoom").onclick = (e) => { const v = e.target.dataset.v; if (!v) return; S.zoom = v; store.set("zoom", v); syncMenu(); layoutDevice(); };
$("seg-wrap").onclick = (e) => { const v = e.target.dataset.v; if (!v) return; S.wrap = v === "1"; store.set("wrap", S.wrap); syncMenu(); view.dispatch({ effects: wrapping.reconfigure(S.wrap ? EditorView.lineWrapping : []) }); };
$("seg-font").onclick = (e) => { const v = Number(e.target.dataset.v); if (!v) return; S.font = Math.max(8, Math.min(20, S.font + v)); store.set("font", S.font); view.dispatch({ effects: sizing.reconfigure(fontTheme(S.font)) }); toast(`Code text ${S.font}px`, 900); };
$("seg-split").onclick = (e) => { const v = e.target.dataset.v; if (!v) return; setSplit({ code: 0.68, even: 0.5, app: 0.36 }[v]); };

function setSplit(frac) {
  frac = Math.max(0.15, Math.min(0.85, frac));
  document.documentElement.style.setProperty("--code-w", (frac * 100).toFixed(2) + "%");
  store.set("split", frac);
  layoutDevice();
}
setSplit(store.get("split", 0.5));
{
  const div = $("divider"); let dragging = false, lastTap = 0;
  div.addEventListener("pointerdown", (e) => {
    const now = Date.now();
    if (now - lastTap < 320) { setSplit(store.get("split", 0.5) > 0.55 ? 0.4 : 0.68); lastTap = 0; return; }
    lastTap = now;
    dragging = true; div.classList.add("dragging"); div.setPointerCapture(e.pointerId);
    frame.style.pointerEvents = "none";
  });
  div.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = $("split").getBoundingClientRect();
    setSplit((e.clientX - r.left) / r.width);
  });
  const end = () => { dragging = false; div.classList.remove("dragging"); frame.style.pointerEvents = ""; };
  div.addEventListener("pointerup", end); div.addEventListener("pointercancel", end);
}
new ResizeObserver(layoutDevice).observe($("preview-pane"));

// ------------------------------------------------------------------ start
fitViewport();
updateUndo();
const last = store.get("project", null);
const params = new URLSearchParams(location.search);
if (params.get("project")) loadProject(params.get("project"), { page: params.get("page"), file: params.get("file") }).catch(() => openPicker("projects"));
else if (last) loadProject(last).catch(() => openPicker("projects"));
else openPicker("projects");
