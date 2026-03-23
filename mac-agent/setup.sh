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

read -p "Enter your Oracle Cloud server IP: " SERVER_IP
read -p "Enter room name (default: default): " ROOM_NAME
ROOM_NAME=${ROOM_NAME:-default}
read -p "Enter room password (default: changeme): " ROOM_PASS
ROOM_PASS=${ROOM_PASS:-changeme}
read -p "Enter FPS (default: 15): " FPS_VAL
FPS_VAL=${FPS_VAL:-15}
read -p "Enter quality 1-31, lower=better (default: 5): " QUAL_VAL
QUAL_VAL=${QUAL_VAL:-5}

cat > .env << EOF
SIGNAL_SERVER=ws://${SERVER_IP}:3000
ROOM=${ROOM_NAME}
ROOM_PASSWORD=${ROOM_PASS}
FPS=${FPS_VAL}
QUALITY=${QUAL_VAL}
SCALE=1280:-1
EOF

echo ""
echo "Created .env file"

AGENT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_PATH="$(which node)"

PLIST_FILE="com.remote.desktop.agent.plist"
sed -i '' "s|AGENT_PATH|${AGENT_DIR}|g" "$PLIST_FILE"
sed -i '' "s|/usr/local/bin/node|${NODE_PATH}|g" "$PLIST_FILE"
sed -i '' "s|YOUR_ORACLE_IP|${SERVER_IP}|g" "$PLIST_FILE"
sed -i '' "s|<string>changeme</string>|<string>${ROOM_PASS}</string>|g" "$PLIST_FILE"
sed -i '' "s|<string>default</string>|<string>${ROOM_NAME}</string>|g" "$PLIST_FILE"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To run manually:"
echo "  source .env && node agent.js"
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
echo "Client URL: http://${SERVER_IP}:3000"
