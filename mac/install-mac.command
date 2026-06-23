#!/bin/zsh
set -euo pipefail

APP_NAME="Video Link Downloader Helper"
LABEL="com.amanrana.video-link-downloader-helper"
INSTALL_DIR="$HOME/Applications/$APP_NAME"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/$LABEL.plist"
SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
HELPER_SRC="$PROJECT_DIR/helper"

if [[ ! -f "$HELPER_SRC/server.mjs" ]]; then
  echo "Could not find the helper folder next to this installer."
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js is needed to run the helper."
  echo "Install Node.js from https://nodejs.org, then run this installer again."
  exit 1
fi

PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "Python 3 is needed to prepare the local downloader engine."
  echo "Install Python 3 from https://www.python.org/downloads/macos/, then run this installer again."
  exit 1
fi

echo "Installing $APP_NAME..."
mkdir -p "$INSTALL_DIR" "$LAUNCH_AGENTS_DIR"
rsync -a --delete \
  --exclude "downloads/" \
  --exclude ".venv-py39-backup/" \
  --exclude "helper.log" \
  "$HELPER_SRC/" "$INSTALL_DIR/"
mkdir -p "$INSTALL_DIR/downloads"

cd "$INSTALL_DIR"
if [[ ! -x ".venv/bin/python" ]] || ! ".venv/bin/python" -m yt_dlp --version >/dev/null 2>&1 || ! ".venv/bin/python" -c "import imageio_ffmpeg" >/dev/null 2>&1; then
  echo "Preparing local downloader engine..."
  rm -rf .venv
  "$PYTHON_BIN" -m venv .venv
  ".venv/bin/python" -m pip install --upgrade pip
  ".venv/bin/python" -m pip install --upgrade yt-dlp imageio-ffmpeg
fi

cat > "$INSTALL_DIR/start-helper.command" <<EOF
#!/bin/zsh
cd "$INSTALL_DIR"
exec "$NODE_BIN" server.mjs
EOF
chmod +x "$INSTALL_DIR/start-helper.command"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$INSTALL_DIR/server.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/helper.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/helper.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
sleep 1
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1; then
  sleep 2
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
fi
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo ""
echo "Installed and started."
echo "Helper health check:"
for attempt in 1 2 3 4 5; do
  if curl -s "http://localhost:8787/api/health"; then
    break
  fi
  sleep 1
done
echo ""
echo ""
echo "Next: open Chrome Extensions, load the extension folder, then click Video Link Downloader."
