#!/bin/bash
set -e

echo "=== Remote Desktop Server Setup (Oracle Cloud) ==="
echo ""

if ! command -v node &> /dev/null; then
  echo "Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "Installing npm dependencies..."
npm install

PORT_VAL=3000

echo ""
echo "=== Opening firewall port ${PORT_VAL} ==="
sudo iptables -I INPUT -p tcp --dport ${PORT_VAL} -j ACCEPT || true
echo "NOTE: Also open port ${PORT_VAL} in Oracle Cloud Console:"
echo "  Networking > VCN > Security Lists > Add Ingress Rule"
echo "  Source: 0.0.0.0/0, TCP, Dest Port: ${PORT_VAL}"

echo ""
echo "=== Starting server ==="
echo "Room password: pass"
echo "Port: ${PORT_VAL}"
echo ""

node server.js
