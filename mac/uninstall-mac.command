#!/bin/zsh
set -euo pipefail

APP_NAME="Video Link Downloader Helper"
LABEL="com.amanrana.video-link-downloader-helper"
INSTALL_DIR="$HOME/Applications/$APP_NAME"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"
rm -rf "$INSTALL_DIR"

echo "Removed $APP_NAME."
