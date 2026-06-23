#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"

if [[ -f "$SCRIPT_DIR/install-mac.command" ]]; then
  INSTALLER_PATH="$SCRIPT_DIR/install-mac.command"
  PROJECT_DIR="${SCRIPT_DIR:h}"
elif [[ -f "$SCRIPT_DIR/mac/install-mac.command" ]]; then
  INSTALLER_PATH="$SCRIPT_DIR/mac/install-mac.command"
  PROJECT_DIR="$SCRIPT_DIR"
else
  echo "Could not find the Mac installer in this package."
  echo "Please unzip the full video-link-downloader-mac folder and try again."
  exit 1
fi

echo "Video Link Downloader"
echo ""
echo "Step 1 of 2: installing the local helper..."
"$INSTALLER_PATH"

echo ""
echo "Step 2 of 2: opening Chrome Extensions."
echo ""
echo "In Chrome:"
echo "1. Turn on Developer mode."
echo "2. Click Load unpacked."
echo "3. Select this folder:"
echo "$PROJECT_DIR/extension"
echo ""

open -a "Google Chrome" "chrome://extensions" >/dev/null 2>&1 || true
open "$PROJECT_DIR" >/dev/null 2>&1 || true

echo "Keep this window open until you finish loading the extension."
read -r "?Press Enter to close..."
