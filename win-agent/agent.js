const { spawn, spawnSync } = require("child_process");
const WebSocket = require("ws");

// Fixed deployment config (no environment variables needed)
const SIGNAL_SERVER = "ws://140.245.15.97/remoteControl/ws";
const ROOM = "default";
const PASSWORD = "pass";
const FPS = 15;
const QUALITY = 10;
const SCALE = "960:-1";
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 1;
const MAX_WS_BUFFERED_BYTES = 512 * 1024;

let screenWidth = 1920;
let screenHeight = 1080;
const size = getPrimaryScreenSize();
if (size) {
  screenWidth = size.width;
  screenHeight = size.height;
}

const AUDIO_INPUT = detectAudioInput();

console.log(`Screen: ${screenWidth}x${screenHeight}`);
console.log(`Server: ${SIGNAL_SERVER}`);
console.log(`FPS: ${FPS}, Quality: ${QUALITY}, Scale: ${SCALE}`);
console.log(`Audio input: ${AUDIO_INPUT || "disabled (no loopback device found)"}`);

let ws = null;
let ffmpegProcess = null;
let audioProcess = null;
let inputWorker = null;
let clientConnected = false;

function getPrimaryScreenSize() {
  const p = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output \"$($b.Width) $($b.Height)\""
    ],
    { encoding: "utf8" }
  );
  const out = `${p.stdout || ""}`.trim();
  const parts = out.split(/\s+/).map((v) => parseInt(v, 10));
  if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
    return { width: parts[0], height: parts[1] };
  }
  return null;
}

function detectAudioInput() {
  const p = spawnSync(
    "ffmpeg",
    ["-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    { encoding: "utf8" }
  );
  const out = `${p.stdout || ""}\n${p.stderr || ""}`;
  const lines = out.split("\n");

  let inAudio = false;
  const devices = [];
  for (const line of lines) {
    if (/DirectShow audio devices/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (/DirectShow video devices/i.test(line)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const m = line.match(/"(.+?)"/);
    if (m) devices.push(m[1]);
  }

  const preferredRegex = /virtual-audio-capturer|stereo mix|what u hear|cable output|vb-audio/i;
  const preferred = devices.find((name) => preferredRegex.test(name));
  return preferred || null;
}

function connectSignaling() {
  console.log("Connecting to signaling server...");
  ws = new WebSocket(SIGNAL_SERVER);

  ws.on("open", () => {
    console.log("Connected to signaling server");
    ws.send(JSON.stringify({ type: "join", room: ROOM, password: PASSWORD, role: "host" }));
  });

  ws.on("message", (data) => {
    if (Buffer.isBuffer(data) && data[0] !== 0x7B) return;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "joined") {
      console.log("Joined room as host");
    }

    if (msg.type === "client-connected") {
      console.log("Client connected, starting capture...");
      clientConnected = true;
      startInputWorker();
      sendScreenInfo();
      startCapture();
    }

    if (msg.type === "client-disconnected") {
      console.log("Client disconnected, stopping capture");
      clientConnected = false;
      stopCapture();
    }

    if (msg.type === "input") {
      handleInput(msg.data);
    }

    if (msg.type === "error") {
      console.error("Server error:", msg.message);
    }
  });

  ws.on("close", () => {
    console.log("Disconnected, reconnecting in 3s...");
    clientConnected = false;
    stopCapture();
    stopInputWorker();
    setTimeout(connectSignaling, 3000);
  });

  ws.on("error", (err) => {
    console.error("WS error:", err.message);
  });
}

function sendScreenInfo() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "screen-info", width: screenWidth, height: screenHeight }));
  }
}

function startCapture() {
  if (ffmpegProcess) return;

  const args = [
    "-f", "gdigrab",
    "-draw_mouse", "1",
    "-framerate", String(FPS),
    "-i", "desktop",
    "-vf", `scale=${SCALE}`,
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-q:v", String(QUALITY),
    "-r", String(FPS),
    "pipe:1"
  ];

  console.log("Starting ffmpeg video...");
  ffmpegProcess = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  let buffer = Buffer.alloc(0);
  ffmpegProcess.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let start = -1;
    for (let i = 0; i < buffer.length - 1; i++) {
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd8) start = i;
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd9 && start !== -1) {
        const frame = buffer.slice(start, i + 2);
        sendFrame(frame);
        buffer = buffer.slice(i + 2);
        start = -1;
        i = -1;
      }
    }
  });

  ffmpegProcess.stderr.on("data", () => {
    // Ignore ffmpeg progress spam.
  });

  ffmpegProcess.on("close", (code) => {
    console.log("ffmpeg video exited:", code);
    ffmpegProcess = null;
    if (clientConnected) {
      setTimeout(startCapture, 1000);
    }
  });

  startAudioCapture();
}

function startAudioCapture() {
  if (audioProcess || !AUDIO_INPUT) return;

  const args = [
    "-f", "dshow",
    "-i", `audio=${AUDIO_INPUT}`,
    "-ac", String(AUDIO_CHANNELS),
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "pipe:1"
  ];

  console.log("Starting ffmpeg audio...");
  audioProcess = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  audioProcess.stdout.on("data", (chunk) => {
    if (ws && ws.readyState === 1 && clientConnected) {
      try {
        ws.send(Buffer.concat([Buffer.from([0x02]), chunk]), { binary: true });
      } catch {}
    }
  });

  audioProcess.stderr.on("data", () => {
    // Ignore ffmpeg progress spam.
  });

  audioProcess.on("close", (code) => {
    if (code !== 0 && clientConnected) {
      console.log("ffmpeg audio exited:", code);
      setTimeout(startAudioCapture, 1000);
    }
    audioProcess = null;
  });
}

function sendFrame(frame) {
  if (ws && ws.readyState === 1 && clientConnected) {
    if (typeof ws.bufferedAmount === "number" && ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      return;
    }
    try {
      ws.send(frame, { binary: true });
    } catch {}
  }
}

function stopCapture() {
  if (ffmpegProcess) {
    ffmpegProcess.kill("SIGTERM");
    ffmpegProcess = null;
  }
  if (audioProcess) {
    audioProcess.kill("SIGTERM");
    audioProcess = null;
  }
}

function startInputWorker() {
  if (inputWorker) return;
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NativeInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$MOUSEEVENTF_RIGHTDOWN = 0x0008
$MOUSEEVENTF_RIGHTUP = 0x0010
$MOUSEEVENTF_WHEEL = 0x0800
$KEYEVENTF_KEYUP = 0x0002
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if (-not $line) { continue }
  $parts = $line.Split(' ')
  if ($parts.Length -eq 0) { continue }
  switch ($parts[0]) {
    "move" {
      [NativeInput]::SetCursorPos([int]$parts[1], [int]$parts[2]) | Out-Null
    }
    "mdown" {
      if ($parts[1] -eq "2") {
        [NativeInput]::mouse_event($MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      } else {
        [NativeInput]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      }
    }
    "mup" {
      if ($parts[1] -eq "2") {
        [NativeInput]::mouse_event($MOUSEEVENTF_RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
      } else {
        [NativeInput]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      }
    }
    "click" {
      [NativeInput]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      [NativeInput]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
    }
    "wheel" {
      [NativeInput]::mouse_event($MOUSEEVENTF_WHEEL, 0, 0, [uint32]([int]$parts[1]), [UIntPtr]::Zero)
    }
    "keydown" {
      [NativeInput]::keybd_event([byte]([int]$parts[1]), 0, 0, [UIntPtr]::Zero)
    }
    "keyup" {
      [NativeInput]::keybd_event([byte]([int]$parts[1]), 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
    }
  }
}
`;
  inputWorker = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
    { stdio: ["pipe", "ignore", "ignore"] }
  );
}

function stopInputWorker() {
  if (inputWorker) {
    inputWorker.kill("SIGTERM");
    inputWorker = null;
  }
}

function sendInputCommand(cmd) {
  if (!inputWorker || !inputWorker.stdin || inputWorker.killed) return;
  try {
    inputWorker.stdin.write(`${cmd}\n`);
  } catch {}
}

function handleInput(data) {
  if (!data || !data.action) return;

  switch (data.action) {
    case "mousemove": {
      const x = Math.round((data.x || 0) * screenWidth);
      const y = Math.round((data.y || 0) * screenHeight);
      sendInputCommand(`move ${x} ${y}`);
      break;
    }
    case "mousedown": {
      const x = Math.round((data.x || 0) * screenWidth);
      const y = Math.round((data.y || 0) * screenHeight);
      const button = Number(data.button || 0);
      sendInputCommand(`move ${x} ${y}`);
      sendInputCommand(`mdown ${button}`);
      break;
    }
    case "mouseup": {
      const x = Math.round((data.x || 0) * screenWidth);
      const y = Math.round((data.y || 0) * screenHeight);
      const button = Number(data.button || 0);
      sendInputCommand(`move ${x} ${y}`);
      sendInputCommand(`mup ${button}`);
      break;
    }
    case "dblclick": {
      const x = Math.round((data.x || 0) * screenWidth);
      const y = Math.round((data.y || 0) * screenHeight);
      sendInputCommand(`move ${x} ${y}`);
      sendInputCommand("click 0");
      sendInputCommand("click 0");
      break;
    }
    case "scroll": {
      const wheelDelta = Math.round(-(data.deltaY || 0));
      sendInputCommand(`wheel ${wheelDelta}`);
      break;
    }
    case "keydown": {
      const vk = getVirtualKeyCode(data);
      if (vk !== null) {
        sendInputCommand(`keydown ${vk}`);
      }
      break;
    }
    case "keyup": {
      const vk = getVirtualKeyCode(data);
      if (vk !== null) {
        sendInputCommand(`keyup ${vk}`);
      }
      break;
    }
  }
}

function getVirtualKeyCode(data) {
  if (!data || typeof data.key !== "string") return null;
  const key = data.key;
  const map = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    " ": 32,
    Shift: 16,
    Control: 17,
    Alt: 18,
    Meta: 91,
    CapsLock: 20,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    F1: 112,
    F2: 113,
    F3: 114,
    F4: 115,
    F5: 116,
    F6: 117,
    F7: 118,
    F8: 119,
    F9: 120,
    F10: 121,
    F11: 122,
    F12: 123
  };
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];

  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= "A" && upper <= "Z") return upper.charCodeAt(0);
    if (key >= "0" && key <= "9") return key.charCodeAt(0);
  }
  return null;
}

process.on("SIGINT", () => {
  console.log("Shutting down...");
  stopCapture();
  stopInputWorker();
  if (ws) ws.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopCapture();
  stopInputWorker();
  if (ws) ws.close();
  process.exit(0);
});

connectSignaling();
