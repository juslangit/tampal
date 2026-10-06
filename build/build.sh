#!/bin/sh
# Rebuilds web/vendor/cm.js (the code editor) from npm. Only needed to update CodeMirror.
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --silent
npx esbuild cm-entry.js --bundle --format=esm --minify --outfile=../web/vendor/cm.js
