#!/bin/bash
set -e

echo "=== Remote Desktop Mac Agent Setup ==="
echo ""

if ! command -v brew &> /dev/null; then
  echo "Homebrew not found. Install it from https://brew.sh"
  exit 1
fi

if ! command -v node &> /dev/null; then
  echo "Installing Node.js..."
  brew install node
fi

if ! command -v ffmpeg &> /dev/null; then
  echo "Installing ffmpeg..."
  brew install ffmpeg
fi

if ! command -v cliclick &> /dev/null; then
  echo "Installing cliclick (for mouse/keyboard control)..."
  brew install cliclick
fi

echo "Installing npm dependencies..."
npm install

AGENT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_PATH="$(which node)"

PLIST_FILE="com.remote.desktop.agent.plist"
sed -i '' "s|AGENT_PATH|${AGENT_DIR}|g" "$PLIST_FILE"
sed -i '' "s|/usr/local/bin/node|${NODE_PATH}|g" "$PLIST_FILE"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To run manually:"
echo "  node agent.js"
echo ""
echo "To install as background service (auto-start on login):"
echo "  cp ${PLIST_FILE} ~/Library/LaunchAgents/"
echo "  launchctl load ~/Library/LaunchAgents/${PLIST_FILE}"
echo ""
echo "To stop the background service:"
echo "  launchctl unload ~/Library/LaunchAgents/${PLIST_FILE}"
echo ""
echo "IMPORTANT: Grant these permissions in System Settings > Privacy & Security:"
echo "  1. Screen Recording -> Terminal (or your terminal app)"
echo "  2. Accessibility -> Terminal (or your terminal app)"
echo "  3. If using LaunchAgent, also add 'node' to both"
echo ""
echo "Client URL: http://140.245.15.97/remoteControl/"
