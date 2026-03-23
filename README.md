# Remote Desktop System

Custom remote desktop: stream your Mac's screen to a Windows machine, with keyboard/mouse control.

## Architecture

```
          Oracle Cloud VM
      ┌──────────────────────┐
      │   Node.js Server     │
      │  (signaling + relay) │
      │   Serves client UI   │
      └──────────┬───────────┘
                 │
      ┌──────────┴──────────┐
      │                     │
   Mac (Host)         Windows (Client)
   ffmpeg capture     Browser UI
   input simulation   mouse/keyboard capture
   background agent   browser renderer
```

## How It Works

1. Mac agent captures screen via ffmpeg → sends JPEG frames over WebSocket to server
2. Server relays frames to the Windows client browser
3. Client renders frames on a canvas
4. Client captures mouse/keyboard events → sends to server → relays to Mac agent
5. Mac agent simulates the input using cliclick / Quartz CGEvents

## Quick Start

### Step 1: Deploy Server (Oracle Cloud)

```bash
# SSH into your Oracle VM
ssh user@YOUR_ORACLE_IP

# Copy the signaling-server folder to your VM
# Then:
cd signaling-server
chmod +x setup.sh
./setup.sh
```

Make sure port 3000 is open:
- Oracle Cloud Console → Networking → VCN → Security Lists → Add Ingress Rule
  - Source CIDR: 0.0.0.0/0
  - Protocol: TCP
  - Destination Port: 3000
- On the VM: `sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT`

To run the server persistently:
```bash
# Using nohup
nohup node server.js &

# Or using pm2
npm install -g pm2
pm2 start server.js --name remote-desktop
pm2 save
pm2 startup
```

### Step 2: Setup Mac Agent (Host)

```bash
cd mac-agent
chmod +x setup.sh
./setup.sh
```

The setup script will:
- Install ffmpeg, cliclick, and Node.js dependencies
- Configure the LaunchAgent plist

To run manually:
```bash
cd mac-agent
node agent.js
```

To run in background (no Dock icon, starts on login):
```bash
cp com.remote.desktop.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.remote.desktop.agent.plist
```

**IMPORTANT macOS Permissions:**

Go to System Settings → Privacy & Security and enable:
1. **Screen Recording** → Add Terminal (or iTerm/your terminal app)
2. **Accessibility** → Add Terminal (or iTerm/your terminal app)

If using LaunchAgent, also add `node` to both permission lists.

### Step 3: Connect from Windows

Open Chrome on your Windows machine:
```
http://YOUR_ORACLE_IP/remoteControl/
```

Enter the room name and password, then click Connect.

## Configuration

This project now uses fixed in-code configuration (no `.env` required):

- Server port: `3000` (internal, proxied by Nginx)
- Server base path: `/remoteControl`
- WebSocket path: `/remoteControl/ws`
- Room password: `pass`
- Mac signaling server: `ws://140.245.15.97/remoteControl/ws`
- Room: `default`
- FPS: `15`
- Quality: `5`
- Scale: `1280:-1`

### Performance Tuning

- **Same network**: Set FPS=30, QUALITY=3 for smooth experience
- **Over internet**: FPS=10-15, QUALITY=5-8 depending on upload speed
- **Low bandwidth**: FPS=8, QUALITY=10, SCALE=960:-1

### Audio Streaming

Audio streaming is now supported when a loopback audio device is available on Mac.

- Install BlackHole (recommended): https://existential.audio/blackhole/
- In Audio MIDI Setup, route system output through a Multi-Output Device that includes BlackHole.
- The host auto-detects `BlackHole` (or similar loopback devices) and streams PCM audio to the browser.
- If no loopback device is found, audio is disabled to avoid capturing microphone by mistake.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Black screen | Grant Screen Recording permission, restart terminal |
| No mouse/keyboard control | Grant Accessibility permission, restart terminal |
| Connection refused | Check server is running, port 3000 open on Oracle |
| Low FPS | Reduce QUALITY value, lower SCALE resolution |
| ffmpeg errors | Run `ffmpeg -f avfoundation -list_devices true -i ""` to check device indices |
| Agent won't connect | Verify Nginx forwards `/remoteControl/ws` to the Node server |

## Security Recommendations

- Change the default room password
- Use nginx reverse proxy with SSL for production:
  ```
  server {
      listen 443 ssl;
      ssl_certificate /path/to/cert.pem;
      ssl_certificate_key /path/to/key.pem;

      location / {
          proxy_pass http://localhost:3000;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection "upgrade";
      }
  }
  ```
- Consider IP whitelisting on your Oracle security list

## File Structure

```
remote-desktop/
├── signaling-server/          # Deploy on Oracle Cloud
│   ├── server.js              # Node.js signaling + relay server
│   ├── setup.sh               # Server setup script
│   ├── package.json
│   └── public/
│       └── index.html         # Windows client UI
├── mac-agent/                 # Run on your Mac
│   ├── agent.js               # Screen capture + input handler
│   ├── setup.sh               # Mac setup script
│   ├── package.json
│   └── com.remote.desktop.agent.plist  # LaunchAgent for background run
└── README.md
```
