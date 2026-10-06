// Runs inside the preview, in the app's own page. tampal's server adds it to every HTML page it
// serves. It never changes the app; it watches for taps (only while 🎯 is on), draws the boxes
// over what was tapped, and tells the editor page next door what it was and where it came from.
(() => {
  if (window.__tampal || window.parent === window) return;
  window.__tampal = true;
  const post = (msg) => window.parent.postMessage({ tampal: true, ...msg }, location.origin);
  let inspecting = false, selected = null, hovered = null;

  // ------------------------------------------------------------ the boxes drawn over the page
  const layer = document.createElement("div");
  layer.setAttribute("data-tampal-ui", "");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const box = (color) => {
    const d = document.createElement("div");
    d.style.cssText = `position:fixed;box-sizing:border-box;pointer-events:none;background:${color};display:none;`;
    layer.appendChild(d); return d;
  };
  const marginBoxes = [box("rgba(246,178,107,.45)"), box("rgba(246,178,107,.45)"), box("rgba(246,178,107,.45)"), box("rgba(246,178,107,.45)")];
  const paddingBoxes = [box("rgba(147,196,125,.5)"), box("rgba(147,196,125,.5)"), box("rgba(147,196,125,.5)"), box("rgba(147,196,125,.5)")];
  const content = box("rgba(111,168,220,.35)");
  const outline = box("transparent"); outline.style.outline = "1.5px solid #ff4fa3";
  let gapBoxes = [];
  const label = document.createElement("div");
  label.style.cssText = "position:fixed;pointer-events:none;font:600 11px/1.3 -apple-system,system-ui,sans-serif;color:#fff;" +
    "background:#ff4fa3;padding:2px 6px;border-radius:4px;white-space:nowrap;display:none;max-width:90vw;overflow:hidden;text-overflow:ellipsis";
  layer.appendChild(label);
  const attach = () => { if (!layer.isConnected) (document.body || document.documentElement).appendChild(layer); };

  const place = (d, x, y, w, h) => {
    if (w <= 0.5 || h <= 0.5) { d.style.display = "none"; return; }
    Object.assign(d.style, { display: "block", left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
  };
  const px = (v) => parseFloat(v) || 0;

  function draw(el) {
    for (const g of gapBoxes) g.remove();
    gapBoxes = [];
    if (!el || !el.isConnected) { for (const d of layer.children) d.style.display = "none"; return; }
    attach();
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const m = { t: px(cs.marginTop), r: px(cs.marginRight), b: px(cs.marginBottom), l: px(cs.marginLeft) };
    const p = { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) };
    const bw = { t: px(cs.borderTopWidth), r: px(cs.borderRightWidth), b: px(cs.borderBottomWidth), l: px(cs.borderLeftWidth) };
    // margin: four strips around the border box
    place(marginBoxes[0], r.left - m.l, r.top - m.t, r.width + m.l + m.r, m.t);
    place(marginBoxes[1], r.left - m.l, r.bottom, r.width + m.l + m.r, m.b);
    place(marginBoxes[2], r.left - m.l, r.top, m.l, r.height);
    place(marginBoxes[3], r.right, r.top, m.r, r.height);
    // padding: four strips inside the border
    const ix = r.left + bw.l, iy = r.top + bw.t, iw = r.width - bw.l - bw.r, ih = r.height - bw.t - bw.b;
    place(paddingBoxes[0], ix, iy, iw, p.t);
    place(paddingBoxes[1], ix, iy + ih - p.b, iw, p.b);
    place(paddingBoxes[2], ix, iy + p.t, p.l, ih - p.t - p.b);
    place(paddingBoxes[3], ix + iw - p.r, iy + p.t, p.r, ih - p.t - p.b);
    place(content, ix + p.l, iy + p.t, iw - p.l - p.r, ih - p.t - p.b);
    place(outline, r.left, r.top, r.width, r.height);
    // gap: the space between neighbouring children of a flex or grid box, hatched purple
    if (/flex|grid/.test(cs.display) && (px(cs.rowGap) || px(cs.columnGap))) {
      const kids = [...el.children].filter((k) => !k.hasAttribute("data-tampal-ui") && getComputedStyle(k).position !== "absolute" && getComputedStyle(k).position !== "fixed")
        .map((k) => k.getBoundingClientRect()).filter((k) => k.width || k.height);
      for (let i = 0; i + 1 < kids.length; i++) {
        const a = kids[i], b = kids[i + 1];
        const g = box("repeating-linear-gradient(45deg,rgba(180,120,255,.55) 0 3px,rgba(180,120,255,.15) 3px 6px)");
        gapBoxes.push(g);
        if (b.top >= a.bottom - 1) place(g, ix + p.l, a.bottom, iw - p.l - p.r, b.top - a.bottom);      // stacked
        else if (b.left >= a.right - 1) place(g, a.right, Math.min(a.top, b.top), b.left - a.right, Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top)); // side by side
        else g.remove();
      }
    }
    label.textContent = `${describe(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    label.style.display = "block";
    const lh = 18;
    label.style.left = Math.max(2, Math.min(r.left, innerWidth - label.offsetWidth - 2)) + "px";
    label.style.top = (r.top - m.t > lh + 4 ? r.top - m.t - lh - 2 : Math.min(r.bottom + m.b + 2, innerHeight - lh - 2)) + "px";
  }
  const redraw = () => draw(selected || hovered);
  addEventListener("scroll", redraw, true);
  addEventListener("resize", redraw);
  // Animations and late-loading content move things; keep the boxes on them.
  setInterval(() => { if (selected) draw(selected); }, 500);

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = [...el.classList].slice(0, 3);
    if (cls.length) s += "." + cls.join(".");
    return s;
  }

  // ------------------------------------------------------------ which CSS rules style it
  // Every style rule in a sheet, flattened in source order with its @media around it. The
  // editor parses the same file the same way, so "the 7th rule in style.css" is a line number.
  function flatRules(list, out, media) {
    for (const rule of list) {
      if (rule instanceof CSSStyleRule) { out.push({ rule, media }); continue; }
      if (rule.cssRules && (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule || (window.CSSContainerRule && rule instanceof CSSContainerRule) || (window.CSSLayerBlockRule && rule instanceof CSSLayerBlockRule))) {
        let active = true;
        if (rule instanceof CSSMediaRule) active = matchMedia(rule.conditionText || rule.media.mediaText).matches;
        flatRules(rule.cssRules, out, { text: rule.conditionText || rule.media?.mediaText || "", active: active && (media ? media.active : true) });
      }
    }
    return out;
  }
  const PSEUDO = /::?(before|after|placeholder|selection|marker|first-line|first-letter|backdrop|-webkit-[\w-]+)/g;
  function matchedRules(el) {
    const found = [];
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      const owner = sheet.ownerNode;
      const source = sheet.href ? { href: new URL(sheet.href).pathname } : { inline: owner?.getAttribute?.("data-tampal-loc") || null };
      flatRules(rules, []).forEach(({ rule, media }, index) => {
        if (media && !media.active) return;
        const parts = rule.selectorText.split(",").map((s) => s.trim());
        let hit = null;
        for (const sel of parts) {
          try {
            if (el.matches(sel)) { hit = { sel, pseudo: false }; break; }
            const bare = sel.replace(PSEUDO, "");
            if (bare !== sel && bare && el.matches(bare)) hit = hit || { sel, pseudo: true };
          } catch {}
        }
        if (!hit) return;
        // As written (cssText keeps shorthands): a shorthand holding var()/env() reads back as
        // empty longhands — "padding-top: ;" — through rule.style[i].
        const decls = splitDecls(rule.style.cssText).map((d) => d.replace(/var\(--tampal-safe-(\w+)/g, "env(safe-area-inset-$1"));
        found.push({ ...source, index, selector: rule.selectorText, media: media?.text || "", pseudo: hit.pseudo, decls });
      });
    }
    if (el.getAttribute("style")) found.push({ inlineAttr: true, selector: "style=\"…\"", decls: splitDecls(el.getAttribute("style")) });
    return found.reverse(); // last rule wins in CSS, so show it first
  }

  function splitDecls(text) {
    const out = []; let depth = 0, q = null, cur = "";
    for (const c of text) {
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === ";" && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function locOf(el) {
    for (let n = el, depth = 0; n && n.nodeType === 1; n = n.parentElement, depth++) {
      const loc = n.getAttribute("data-tampal-loc");
      if (loc) return { loc, exact: depth === 0, from: depth ? describe(n) : null };
    }
    return null;
  }

  function info(el) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const four = (k) => ["Top", "Right", "Bottom", "Left"].map((s) => Math.round(px(cs[k + s + (k === "border" ? "Width" : "")]) * 10) / 10);
    const clone = el.cloneNode(true);
    for (const n of [clone, ...clone.querySelectorAll("[data-tampal-loc]")]) n.removeAttribute?.("data-tampal-loc");
    const chain = [];
    for (let n = el; n && n.nodeType === 1 && chain.length < 8; n = n.parentElement) chain.unshift(describe(n));
    return {
      type: "select",
      where: locOf(el),
      tag: el.tagName.toLowerCase(), id: el.id || "", classes: [...el.classList],
      label: describe(el), chain,
      outer: clone.outerHTML.slice(0, 700),
      size: [Math.round(r.width), Math.round(r.height)],
      at: [Math.round(r.left), Math.round(r.top)],
      box: {
        margin: four("margin"), padding: four("padding"), border: four("border"),
        display: cs.display, position: cs.position,
        gap: cs.display.includes("flex") || cs.display.includes("grid") ? `${cs.rowGap} ${cs.columnGap}`.replace(/normal/g, "0") : "",
        flex: cs.display.includes("flex") ? `${cs.flexDirection} · justify ${cs.justifyContent} · align ${cs.alignItems}` : "",
        lineHeight: cs.lineHeight, fontSize: cs.fontSize,
      },
      rules: matchedRules(el),
    };
  }

  // ------------------------------------------------------------ taps
  // A tap selects; a drag still scrolls the app. Taps are swallowed while inspecting, so
  // buttons and links in the app don't fire while Luqman is pointing at them.
  let down = null;
  const swallow = (e) => { if (inspecting && !e.target?.closest?.("[data-tampal-ui]")) { e.stopImmediatePropagation(); if (e.type !== "touchstart" && e.type !== "touchmove" && e.type !== "pointermove") e.preventDefault(); } };
  for (const t of ["mousedown", "mouseup", "click", "dblclick", "touchstart", "touchend", "contextmenu", "submit", "focusin"]) addEventListener(t, swallow, { capture: true, passive: false });
  addEventListener("pointerdown", (e) => { if (!inspecting) return; down = { x: e.clientX, y: e.clientY, t: Date.now() }; swallow(e); }, { capture: true, passive: false });
  addEventListener("pointerup", (e) => {
    if (!inspecting) return;
    swallow(e);
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 10) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== layer) select(el);
  }, { capture: true });
  addEventListener("mousemove", (e) => {   // on the Mac, show what the mouse is over
    if (!inspecting || e.pointerType === "touch") return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el !== hovered) { hovered = el; if (!selected) draw(el); }
  }, true);

  function select(el) {
    selected = el; hovered = null;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
    draw(el);
    post(info(el));
  }

  // ------------------------------------------------------------ messages from the editor
  addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data?.tampal) return;
    const m = e.data;
    if (m.type === "inspect") { inspecting = m.on; if (!m.on && !selected) draw(null); }
    if (m.type === "clear") { selected = null; draw(null); }
    if (m.type === "parent" && selected?.parentElement && selected.parentElement !== document.documentElement) select(selected.parentElement);
    if (m.type === "child" && selected?.firstElementChild) select(selected.firstElementChild);
    if (m.type === "refresh" && selected) post({ ...info(selected), type: "updated" });
    // From the code: the cursor is on a tag in the editor — show which element that is.
    if (m.type === "reveal") {
      const el = document.querySelector(`[data-tampal-loc="${m.loc}"]`) || [...document.querySelectorAll("[data-tampal-loc]")].find((n) => n.getAttribute("data-tampal-loc").startsWith(m.line + ":"));
      if (el && el !== document.documentElement && el !== document.head && !el.closest("head")) {
        selected = el; draw(el);
        if (m.scroll !== false) { const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) el.scrollIntoView({ block: "center" }); }
        post({ ...info(el), type: "revealed" });
      }
    }
    if (m.type === "reselect") {
      // After a reload: select it again quietly, without pulling the editor's cursor away.
      const el = m.loc && document.querySelector(`[data-tampal-loc="${m.loc}"]`);
      if (el) { selected = el; draw(el); post({ ...info(el), type: "updated" }); }
    }
    // A CSS file was saved: swap it in place, without reloading the page or losing its state.
    if (m.type === "css") {
      let swapped = false;
      for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
        const u = new URL(link.href, location.href);
        if (u.pathname === m.path || m.alt?.includes(u.pathname)) {
          u.searchParams.set("tampal", Date.now());
          const fresh = link.cloneNode(); fresh.href = u.href;
          fresh.onload = () => { link.remove(); redraw(); if (selected) post({ ...info(selected), type: "updated" }); };
          link.after(fresh); swapped = true;
        }
      }
      post({ type: "css-swapped", ok: swapped, path: m.path });
    }
    if (m.type === "scroll") scrollTo(0, m.y || 0);
  });

  // Tell the editor which page this is, what it asks of the phone, and where it was scrolled.
  addEventListener("DOMContentLoaded", () => {
    const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content || "";
    post({ type: "page", path: location.pathname, title: document.title,
      viewport: meta("viewport"), statusBar: meta("apple-mobile-web-app-status-bar-style"), themeColor: meta("theme-color"),
      background: getComputedStyle(document.body || document.documentElement).backgroundColor });
  });
  addEventListener("pagehide", () => post({ type: "leaving", y: scrollY }));
  addEventListener("error", (e) => post({ type: "app-error", text: `${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})` }));
})();
