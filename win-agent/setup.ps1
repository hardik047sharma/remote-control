$ErrorActionPreference = "Stop"

Write-Host "=== Remote Desktop Windows Agent Setup ==="
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js not found. Install Node.js LTS first: https://nodejs.org"
  exit 1
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host "ffmpeg not found in PATH."
  Write-Host "Install ffmpeg and add it to PATH (for example via winget):"
  Write-Host "  winget install --id Gyan.FFmpeg -e"
  exit 1
}

Write-Host "Installing npm dependencies..."
npm install

Write-Host ""
Write-Host "=== Setup Complete ==="
Write-Host "Run host agent with:"
Write-Host "  node agent.js"
Write-Host ""
Write-Host "Client URL:"
Write-Host "  http://140.245.15.97/remoteControl/"
Write-Host ""
Write-Host "Optional audio:"
Write-Host "  Install VB-Audio Virtual Cable or enable Stereo Mix."
Write-Host "  The agent auto-detects loopback devices for system audio."
