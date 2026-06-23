#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"

echo "Video Link Downloader"
echo ""
echo "Step 1 of 2: installing the local helper..."
"$SCRIPT_DIR/install-mac.command"

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
