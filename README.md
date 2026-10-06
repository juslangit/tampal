# tampal

Fix the small front-end problems in a web app — the gap under Siti's message box, a button
1px off — from the iPhone. Code on the left, the app on the right inside an iPhone 17, like
Android Studio's layout editor.

- **Tap anything in the app** (🎯 on) → its line lights up in the code, its margin, padding
  and flex/grid gaps are drawn over it, and the CSS rules that style it are listed with
  `file:line`. Tap a rule to jump to it.
- **Type** → it saves to the file on the Mac by itself (every old version is kept in
  `data/history/`). CSS changes appear instantly; HTML/JS reload the app.
- **Ask Claude** → "less gap under this". The `claude` command on the Mac makes the
  smallest change (Read/Edit only, inside that project), you see it, and you can undo it.
- **Move the cursor onto a tag** in the code → that element is outlined in the app.

The phone is an iPhone 17 (402×874pt): status bar and Dynamic Island 62pt, home bar 34pt.
The page gets the shape it asks for — `viewport-fit=cover` and `black-translucent` decide
whether it draws under the status bar and what `env(safe-area-inset-*)` returns. A Safari-tab
mode is there too (approximate).

## Use

```sh
./install.sh        # login item + iPhone link over Tailscale (:8444)
tampal              # open on the Mac
tampal phone        # pairing link for the iPhone — open once in Safari, then Share → Add to Home Screen
tampal status | restart | log
```

## How it works

`server.mjs` (Node built-ins only) serves the app under `/app/<subject>/<project>/…` and
changes two things on the way — never on disk: every HTML start tag gets
`data-tampal-loc="line:col"`, and `env(safe-area-inset-*)` becomes `var(--tampal-safe-*)`
(an iframe always reports zero safe areas). `web/inspector.js` runs inside the app, and
`web/app.js` is the editor (CodeMirror 6, bundled by `build/build.sh` into `web/vendor/cm.js`).

The preview is static: an app with its own server (Siti's `/api/…`) shows its page and CSS
but its data calls fail. Elements made by JavaScript have no line in the HTML, so tampal
searches the JS for their id/classes instead.

## Checks

```sh
cd build && npm install        # once (playwright-core)
node tools/check.mjs                         # tap-to-code on Siti's page, iPhone-sized
node tools/check-edit.mjs <scratch copy> [--claude]   # typing, live save, outside changes, Ask Claude
```
