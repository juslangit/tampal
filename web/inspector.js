// Runs inside the preview, in the app's own page. tampal's server adds it to every HTML page it
// serves. It never changes the app; it watches for taps (only while 🎯 is on), draws the boxes
// over what was tapped, and tells the editor page next door what it was and where it came from.
(() => {
  if (window.__tampal || window.parent === window) return;
  window.__tampal = true;

  // ------------------------------------------------------------ the keyboard, as iOS does it
  // On an iPhone the keyboard does not resize the page: it covers the bottom, and only
  // window.visualViewport gets shorter (and pans, offsetTop, when iOS pushes the page up to keep
  // the field in view). An iframe can't fake that by itself, so visualViewport is replaced with
  // one that reports the keyboard. Installed here, in <head>, before any of the app's scripts.
  const realVV = window.visualViewport;
  const kb = { open: false, height: 0, pan: 0, target: null };
  const vv = new EventTarget();
  if (realVV) {
    const handlers = {};
    const def = (k, get) => Object.defineProperty(vv, k, { get, enumerable: true });
    def("width", () => realVV.width); def("scale", () => realVV.scale);
    def("offsetLeft", () => realVV.offsetLeft); def("pageLeft", () => realVV.pageLeft);
    def("height", () => (kb.open ? kb.height : realVV.height));
    def("offsetTop", () => (kb.open ? kb.pan : realVV.offsetTop));
    def("pageTop", () => scrollY + vv.offsetTop);
    for (const t of ["resize", "scroll", "scrollend"]) {
      Object.defineProperty(vv, "on" + t, { get: () => handlers[t] || null, set: (f) => { handlers[t] = f; } });
      vv.addEventListener(t, (e) => handlers[t]?.call(vv, e));
      realVV.addEventListener(t, () => vv.dispatchEvent(new Event(t)));
    }
    try { Object.defineProperty(window, "visualViewport", { get: () => vv, configurable: true }); } catch {}
  }
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
  // The selected element must not scroll under a finger, or a drag turns into a page scroll
  // (Siti sets touch-action: pan-x pan-y on everything). Only while 🎯 is on.
  const grabStyle = document.createElement("style");
  grabStyle.setAttribute("data-tampal-ui", "");
  grabStyle.textContent = "[data-tampal-grab]{touch-action:none!important;-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important}";
  const attach = () => {
    if (!layer.isConnected) (document.body || document.documentElement).appendChild(layer);
    if (!grabStyle.isConnected) (document.head || document.documentElement).appendChild(grabStyle);
  };
  function mark(el) {
    for (const n of document.querySelectorAll("[data-tampal-grab]")) n.removeAttribute("data-tampal-grab");
    selected = el;
    if (el && inspecting && el !== document.body && el !== document.documentElement) { attach(); el.setAttribute("data-tampal-grab", ""); }
  }

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
      if (sheet.ownerNode?.hasAttribute?.("data-tampal-ui")) continue;
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
        let unique = false; try { unique = document.querySelectorAll(rule.selectorText).length === 1; } catch {}
        found.push({ ...source, index, selector: rule.selectorText, media: media?.text || "", pseudo: hit.pseudo, decls, unique });
      });
    }
    // The style="" as written — without the translate tampal adds while something is being moved.
    let own = el.getAttribute("style") || "";
    if (el.__tampalMove) own = [...splitDecls(own).filter((d) => !/^translate\s*:/.test(d)), ...(el.__tampalMove.before ? [`translate: ${el.__tampalMove.before}`] : [])].join("; ");
    if (own.trim()) found.push({ inlineAttr: true, selector: "style=\"…\"", decls: splitDecls(own) });
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
    for (const n of [clone, ...clone.querySelectorAll("[data-tampal-loc], [data-tampal-grab], [data-tampal-im]")]) {
      n.removeAttribute?.("data-tampal-loc"); n.removeAttribute?.("data-tampal-grab");
      if (n.hasAttribute?.("data-tampal-im")) { const was = n.getAttribute("data-tampal-im"); n.removeAttribute("data-tampal-im"); was ? n.setAttribute("inputmode", was) : n.removeAttribute("inputmode"); }
    }
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
  // A tap selects. Dragging the selected element moves it, like a sprite in a 2D editor: it
  // follows the finger through the CSS `translate` property (nothing else in the page moves),
  // and on release the editor writes the move into the code.
  let down = null, drag = null;
  const swallow = (e) => { if (e.type === "focusin" && kb.focusing) return; if (inspecting && !e.target?.closest?.("[data-tampal-ui]")) { e.stopImmediatePropagation(); if (e.type !== "touchmove" && e.type !== "pointermove" && (e.type !== "touchstart" || grabbable(e.target))) e.preventDefault(); } };
  // Only the selected element (or something inside it) can be grabbed — never the whole page.
  const grabbable = (t) => selected && t instanceof Node && selected.contains(t) && selected !== document.body && selected !== document.documentElement;
  for (const t of ["mousedown", "mouseup", "click", "dblclick", "touchstart", "touchend", "contextmenu", "submit", "focusin"]) addEventListener(t, swallow, { capture: true, passive: false });
  addEventListener("touchmove", (e) => { if (drag || (down && down.grab)) e.preventDefault(); }, { capture: true, passive: false });
  addEventListener("pointerdown", (e) => {
    noRealKeyboard(e.target);
    if (!inspecting) return;
    down = { x: e.clientX, y: e.clientY, t: Date.now(), grab: grabbable(e.target) };
    swallow(e);
  }, { capture: true, passive: false });
  addEventListener("pointermove", (e) => {
    if (!inspecting || !down?.grab) return;
    const dx = Math.round(e.clientX - down.x), dy = Math.round(e.clientY - down.y);
    if (!drag && Math.hypot(dx, dy) < 6) return;
    if (!drag) drag = { base: pendingOf(selected) };
    drag.dx = dx; drag.dy = dy;
    setPending(selected, drag.base.dx + dx, drag.base.dy + dy);
    draw(selected);
    label.textContent = `${describe(selected)}  ↔ ${sign(drag.base.dx + dx)}  ↕ ${sign(drag.base.dy + dy)}`;
  }, { capture: true });
  addEventListener("pointerup", (e) => {
    if (!inspecting) return;
    swallow(e);
    if (drag) { const d = drag; drag = null; down = null; if (d.dx || d.dy) commitMove(d.dx, d.dy); return; }
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 10) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== layer) select(el);
  }, { capture: true });
  addEventListener("pointercancel", () => { if (drag) { setPending(selected, drag.base.dx, drag.base.dy); draw(selected); } drag = null; down = null; }, true);
  const sign = (n) => (n > 0 ? "+" : "") + n;

  // Moves not yet in the CSS the page has loaded, shown with `translate`. Cleared the moment
  // the saved CSS (or the reloaded page) arrives, so the element never jumps twice.
  function pendingOf(el) { return el.__tampalMove || { dx: 0, dy: 0 }; }
  function setPending(el, dx, dy) {
    if (!el.__tampalMove) el.__tampalMove = { dx: 0, dy: 0, before: el.style.translate };
    el.__tampalMove.dx = dx; el.__tampalMove.dy = dy;
    el.style.translate = dx || dy ? `${dx}px ${dy}px` : el.__tampalMove.before;
  }
  function clearPending() {
    for (const el of document.querySelectorAll("*")) if (el.__tampalMove) { el.style.translate = el.__tampalMove.before; delete el.__tampalMove; }
  }

  // What to write for a move: flow elements become position: relative with left/top offsets;
  // positioned ones get their own left/top (or right/bottom, if that is what their CSS uses)
  // shifted; sticky ones, whose top means "where to stick", get `translate` instead.
  function commitMove(dx, dy) {
    const el = selected;
    const pend = pendingOf(el);
    const cs = getComputedStyle(el);
    const total = { dx: pend.dx, dy: pend.dy };          // includes moves not saved yet
    const rules = matchedRules(el);
    const uses = (prop) => rules.some((r) => r.decls.some((d) => new RegExp(`^${prop}\\s*:`).test(d) && !/:\s*auto\b/.test(d)));
    const num = (v) => parseFloat(v) || 0;
    const props = [];
    if (cs.position === "sticky") {
      // the live translate already includes the pending part; take the saved value from before
      const saved = (pend.before || "0px 0px").split(" ").map(num);
      props.push(["translate", `${(saved[0] || 0) + total.dx}px ${(saved[1] || 0) + total.dy}px`]);
    } else {
      if (cs.position === "static") props.push(["position", "relative"]);
      const fixedFlow = cs.position === "static";
      if (total.dx) {
        if (!fixedFlow && uses("right") && !uses("left")) props.push(["right", `${Math.round(num(cs.right) - total.dx)}px`]);
        else props.push(["left", `${Math.round((cs.left === "auto" || fixedFlow ? 0 : num(cs.left)) + total.dx)}px`]);
      }
      if (total.dy) {
        if (!fixedFlow && uses("bottom") && !uses("top")) props.push(["bottom", `${Math.round(num(cs.bottom) - total.dy)}px`]);
        else props.push(["top", `${Math.round((cs.top === "auto" || fixedFlow ? 0 : num(cs.top)) + total.dy)}px`]);
      }
    }
    post({ ...info(el), type: "moved", props, delta: [dx, dy] });
  }

  addEventListener("mousemove", (e) => {   // on the Mac, show what the mouse is over
    if (!inspecting || e.pointerType === "touch") return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el !== hovered) { hovered = el; if (!selected) draw(el); }
  }, true);

  function select(el) {
    mark(el); hovered = null;
    // Keep the keyboard up while pointing at things — checking the message box with the keyboard
    // open is the whole point. Otherwise, don't leave the app's fields focused.
    if (!kb.open && document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
    draw(el);
    post(info(el));
  }

  const EDITABLE = 'textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=password], input[type=number], [contenteditable=""], [contenteditable="true"]';
  const editable = (el) => el instanceof Element && el.matches(EDITABLE) && !el.disabled && !el.readOnly;
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  // On the iPhone itself, a field in the preview must not bring up the phone's real keyboard (it
  // would squash tampal); the drawn one appears instead. Set before the focus, on pointerdown.
  const coarse = matchMedia("(pointer: coarse)").matches;
  function noRealKeyboard(el) {
    if (!coarse || !editable(el) || el.hasAttribute("data-tampal-im")) return;
    el.setAttribute("data-tampal-im", el.getAttribute("inputmode") || "");
    el.setAttribute("inputmode", "none");
  }
  function locOfEl(el) { return el?.getAttribute?.("data-tampal-loc") || ""; }

  function openKeyboard(pref) {
    let el = (pref && document.querySelector(`[data-tampal-loc="${pref}"]`)) || null;
    if (!el && selected && editable(selected)) el = selected;
    if (!el && selected) el = [...selected.querySelectorAll(EDITABLE)].find((e) => editable(e) && visible(e));
    if (!el && editable(document.activeElement)) el = document.activeElement;
    if (!el) el = [...document.querySelectorAll(EDITABLE)].find((e) => editable(e) && visible(e));
    if (!el) { post({ type: "kb-none" }); return; }
    noRealKeyboard(el);
    kb.focusing = true;
    try { el.focus({ preventScroll: true }); } catch {}
    kb.focusing = false;
    if (el.setSelectionRange && typeof el.value === "string") { try { el.setSelectionRange(el.value.length, el.value.length); } catch {} }
    kb.target = el;
    post({ type: "kb-focused", loc: locOfEl(el), label: describe(el) });
  }
  // The editor says how much of the page the keyboard leaves visible.
  function setKeyboard(open, visibleHeight) {
    kb.open = open; kb.height = Math.max(0, visibleHeight || 0); kb.pan = 0;
    vv.dispatchEvent(new Event("resize"));
    vv.dispatchEvent(new Event("scroll"));
    if (!open) {
      if (kb.target && document.activeElement === kb.target) { kb.focusing = true; kb.target.blur(); kb.focusing = false; }
      kb.target = null;
      post({ type: "kb-pan", pan: 0 });
      return;
    }
    setTimeout(keepFieldVisible, 350);   // after the app has reacted, as iOS waits for it
  }
  // iOS keeps the field in view: it scrolls the page if it can, and if that isn't enough it pans
  // the whole page up (the "everything slid up" effect apps get when they don't handle it).
  function keepFieldVisible() {
    if (!kb.open || !kb.target?.isConnected) return;
    const margin = 10;
    let r = kb.target.getBoundingClientRect();
    let need = r.bottom + margin - kb.height;
    const scroller = document.scrollingElement;
    if (need > 0 && scroller) {
      const room = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      if (room > 0) { scroller.scrollTop += Math.min(room, need); r = kb.target.getBoundingClientRect(); need = r.bottom + margin - kb.height; }
    }
    const pan = Math.max(0, Math.min(Math.round(need), innerHeight - kb.height));
    if (pan !== kb.pan) { kb.pan = pan; vv.dispatchEvent(new Event("scroll")); }
    post({ type: "kb-pan", pan: kb.pan, hidden: need > kb.pan + 1 });
    redraw();
  }
  // Tapping into a field in the app (🎯 off) brings the keyboard up; leaving it puts it away.
  addEventListener("focusin", (e) => { if (!inspecting && !kb.focusing && editable(e.target)) { kb.target = e.target; post({ type: "kb-auto", loc: locOfEl(e.target), label: describe(e.target) }); } });
  addEventListener("focusout", () => { if (kb.focusing || inspecting) return; setTimeout(() => { if (!editable(document.activeElement) && kb.open) post({ type: "kb-away" }); }, 0); });

  // ------------------------------------------------------------ messages from the editor
  addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data?.tampal) return;
    const m = e.data;
    if (m.type === "inspect") { inspecting = m.on; mark(selected); if (!m.on && !selected) draw(null); }
    if (m.type === "clear") { mark(null); draw(null); }
    if (m.type === "parent" && selected?.parentElement && selected.parentElement !== document.documentElement) select(selected.parentElement);
    if (m.type === "child" && selected?.firstElementChild) select(selected.firstElementChild);
    if (m.type === "refresh" && selected) post({ ...info(selected), type: "updated" });
    // From the code: the cursor is on a tag in the editor — show which element that is.
    if (m.type === "reveal") {
      const el = document.querySelector(`[data-tampal-loc="${m.loc}"]`) || [...document.querySelectorAll("[data-tampal-loc]")].find((n) => n.getAttribute("data-tampal-loc").startsWith(m.line + ":"));
      if (el && el !== document.documentElement && el !== document.head && !el.closest("head")) {
        mark(el); draw(el);
        if (m.scroll !== false) { const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) el.scrollIntoView({ block: "center" }); }
        post({ ...info(el), type: "revealed" });
      }
    }
    if (m.type === "reselect") {
      // After a reload: select it again quietly, without pulling the editor's cursor away.
      const el = m.loc && document.querySelector(`[data-tampal-loc="${m.loc}"]`);
      if (el) { mark(el); draw(el); post({ ...info(el), type: "updated" }); }
    }
    // A CSS file was saved: swap it in place, without reloading the page or losing its state.
    if (m.type === "css") {
      let swapped = false;
      for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
        const u = new URL(link.href, location.href);
        if (u.pathname === m.path || m.alt?.includes(u.pathname)) {
          u.searchParams.set("tampal", Date.now());
          const fresh = link.cloneNode(); fresh.href = u.href;
          fresh.onload = () => { link.remove(); clearPending(); redraw(); if (kb.open) setTimeout(keepFieldVisible, 100); if (selected) post({ ...info(selected), type: "updated" }); };
          link.after(fresh); swapped = true;
        }
      }
      post({ type: "css-swapped", ok: swapped, path: m.path });
    }
    if (m.type === "scroll") scrollTo(0, m.y || 0);
    if (m.type === "nudge" && selected && selected !== document.body) {
      const p = pendingOf(selected);
      setPending(selected, p.dx + m.dx, p.dy + m.dy); draw(selected);
      commitMove(m.dx, m.dy);
    }
    if (m.type === "unmove") { clearPending(); redraw(); }
    if (m.type === "kb-open") openKeyboard(m.loc);
    if (m.type === "kb-set") setKeyboard(m.open, m.visible);
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
