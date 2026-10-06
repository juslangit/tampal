#!/bin/sh
# Installs tampal on this Mac: the login item that keeps its server running, the `tampal`
# command, and the iPhone link through Tailscale (port 8444). Safe to run again.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.luqman.tampal.plist"
mkdir -p "$ROOT/data/logs" "$HOME/.local/bin" "$HOME/Library/LaunchAgents"
ln -sf "$ROOT/bin/tampal" "$HOME/.local/bin/tampal"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.luqman.tampal</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>$ROOT/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>20</integer>
  <key>StandardOutPath</key><string>$ROOT/data/logs/server.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/logs/server.log</string>
</dict>
</plist>
PL

launchctl bootout "gui/$(id -u)/com.luqman.tampal" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

TS() { /opt/homebrew/opt/tailscale/bin/tailscale --socket="$HOME/Library/Application Support/tailscale-user/tailscaled.sock" "$@"; }
if TS status >/dev/null 2>&1; then
  TS serve --bg --https=8444 http://127.0.0.1:4490 >/dev/null
  echo "iPhone link: on — run 'tampal phone' for the pairing link"
else
  echo "Tailscale is not running — tampal works on this Mac; the iPhone link needs Tailscale."
fi
sleep 1
echo "tampal: http://127.0.0.1:4490 — run 'tampal' to open it"
