const { spawn, execSync, spawnSync } = require("child_process");
const WebSocket = require("ws");

// Fixed deployment config (no environment variables needed)
const SIGNAL_SERVER = "ws://140.245.15.97/remoteControl/ws";
const ROOM = "default";
const PASSWORD = "pass";
const FPS = 15;
const QUALITY = 10;
const SCALE = "960:-1";
const VIDEO_INPUT = detectVideoInput();
const AUDIO_INPUT = detectAudioInput();
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 1;
const MAX_WS_BUFFERED_BYTES = 512 * 1024;

let screenWidth = 1920;
let screenHeight = 1080;

const useCliclick = hasCliclick();
const useQuartzMouse = hasQuartzPython();
const mouseBackend = useQuartzMouse ? "quartz" : (useCliclick ? "cliclick" : "none");
const displaySize = getDisplaySize();
if (displaySize) {
  screenWidth = displaySize.width;
  screenHeight = displaySize.height;
}

console.log(`Screen: ${screenWidth}x${screenHeight}`);
console.log(`Server: ${SIGNAL_SERVER}`);
console.log(`FPS: ${FPS}, Quality: ${QUALITY}, Scale: ${SCALE}`);
console.log(`Video input: ${VIDEO_INPUT}`);
console.log(`Audio input: ${AUDIO_INPUT === null ? "disabled (no suitable device)" : AUDIO_INPUT}`);
console.log(`Mouse backend: ${mouseBackend}`);

let ws = null;
let ffmpegProcess = null;
let audioProcess = null;
let connected = false;
let clientConnected = false;

function detectVideoInput() {
  const out = listAvfoundationDevices();
  const lines = out.split("\n");

  const screenIndices = [];
  for (const line of lines) {
    const m = line.match(/\[(\d+)\]\s+Capture screen/i);
    if (m) screenIndices.push(Number(m[1]));
  }

  if (screenIndices.length > 0) {
    // Prefer the first advertised screen device.
    return `${screenIndices[0]}:none`;
  }

  // No screen capture device found; do not fall back to camera.
  return null;
}

function detectAudioInput() {
  const out = listAvfoundationDevices();
  const lines = out.split("\n");
  let inAudioSection = false;
  const devices = [];

  for (const line of lines) {
    if (/AVFoundation audio devices/i.test(line)) {
      inAudioSection = true;
      continue;
    }
    if (/AVFoundation video devices/i.test(line)) {
      inAudioSection = false;
      continue;
    }
    if (!inAudioSection) continue;
    const m = line.match(/\[(\d+)\]\s+(.+)/);
    if (m) {
      devices.push({ index: Number(m[1]), name: m[2].trim() });
    }
  }

  // Prefer virtual loopback devices for system audio (BlackHole/Loopback/Soundflower).
  const preferred = devices.find((d) => /blackhole|loopback|soundflower/i.test(d.name));
  if (preferred) return preferred.index;

  // If no loopback device exists, disable audio instead of accidentally capturing mic.
  return null;
}

function listAvfoundationDevices() {
  // ffmpeg returns non-zero for -list_devices; parse output regardless of exit code.
  const p = spawnSync("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""], {
    encoding: "utf8"
  });
  return `${p.stdout || ""}\n${p.stderr || ""}`;
}

function hasCliclick() {
  try {
    execSync("which cliclick", { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function hasQuartzPython() {
  try {
    execSync(`python3 -c "import Quartz"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getDisplaySize() {
  // Best path: native CoreGraphics via swift (no pyobjc needed).
  try {
    const swiftOut = execSync(
      `swift -e "import CoreGraphics; let b = CGDisplayBounds(CGMainDisplayID()); print(Int(b.width), Int(b.height))"`,
      { encoding: "utf8" }
    ).trim();
    const s = swiftOut.split(/\s+/).map((v) => parseInt(v, 10));
    if (s.length === 2 && Number.isFinite(s[0]) && Number.isFinite(s[1])) {
      return { width: s[0], height: s[1] };
    }
  } catch {}

  // Fallback: pyobjc Quartz if available.
  try {
    const pyOut = execSync(
      `python3 -c "import Quartz; b=Quartz.CGDisplayBounds(Quartz.CGMainDisplayID()); print(f'{int(b.size.width)} {int(b.size.height)}')"`,
      { encoding: "utf8" }
    ).trim();
    const p = pyOut.split(/\s+/).map((v) => parseInt(v, 10));
    if (p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
      return { width: p[0], height: p[1] };
    }
  } catch {}

  // Last fallback: physical resolution from system_profiler.
  try {
    const sizeStr = execSync(
      `system_profiler SPDisplaysDataType | grep Resolution | head -1 | awk '{print $2, $4}'`,
      { encoding: "utf8" }
    ).trim();
    const parts = sizeStr.split(/\s+/).map((v) => parseInt(v, 10));
    if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      return { width: parts[0], height: parts[1] };
    }
  } catch {}

  return null;
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
      connected = true;
      console.log("Joined room as host");
    }

    if (msg.type === "client-connected") {
      console.log("Client connected, starting capture...");
      clientConnected = true;
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
    connected = false;
    clientConnected = false;
    stopCapture();
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
  if (!VIDEO_INPUT) {
    console.error("No AVFoundation 'Capture screen' device found. Not starting capture.");
    console.error("Run this on Mac and ensure screen devices are listed:");
    console.error("  ffmpeg -f avfoundation -list_devices true -i \"\"");
    return;
  }

  const args = [
    "-f", "avfoundation",
    "-capture_cursor", "1",
    "-framerate", String(FPS),
    "-i", VIDEO_INPUT,
    "-vf", `scale=${SCALE}`,
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "-q:v", String(QUALITY),
    "-r", String(FPS),
    "pipe:1"
  ];

  console.log("Starting ffmpeg...");
  ffmpegProcess = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  let buffer = Buffer.alloc(0);
  let recentStderr = [];

  ffmpegProcess.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    let start = -1;

    for (let i = 0; i < buffer.length - 1; i++) {
      if (buffer[i] === 0xFF && buffer[i + 1] === 0xD8) {
        start = i;
      }
      if (buffer[i] === 0xFF && buffer[i + 1] === 0xD9 && start !== -1) {
        const frame = buffer.slice(start, i + 2);
        sendFrame(frame);
        buffer = buffer.slice(i + 2);
        start = -1;
        i = -1;
      }
    }
  });

  ffmpegProcess.stderr.on("data", (data) => {
    const text = data.toString();
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      recentStderr.push(line);
      if (recentStderr.length > 20) recentStderr.shift();
      if (!line.startsWith("frame=") && !line.includes("time=")) {
        console.log("[ffmpeg]", line);
      }
    }
  });

  ffmpegProcess.on("close", (code) => {
    console.log("ffmpeg exited:", code);
    if (code !== 0 && recentStderr.length) {
      console.log("ffmpeg last errors:");
      for (const line of recentStderr.slice(-8)) {
        console.log(" ", line);
      }
      console.log("If you see permission errors, re-check Screen Recording permission for Terminal/iTerm and restart that app.");
    }
    ffmpegProcess = null;
    if (clientConnected) {
      setTimeout(startCapture, 1000);
    }
  });

  startAudioCapture();
}

function sendFrame(frame) {
  if (ws && ws.readyState === 1 && clientConnected) {
    // Real-time mode: drop stale frames when network/backpressure builds up.
    if (typeof ws.bufferedAmount === "number" && ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      return;
    }
    try {
      // Keep video as raw JPEG bytes for maximum browser compatibility.
      ws.send(frame, { binary: true });
    } catch {}
  }
}

function startAudioCapture() {
  if (audioProcess) return;
  if (AUDIO_INPUT === null) return;

  const args = [
    "-f", "avfoundation",
    "-i", `:${AUDIO_INPUT}`,
    "-ac", String(AUDIO_CHANNELS),
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "pipe:1"
  ];

  console.log("Starting audio capture...");
  audioProcess = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  audioProcess.stdout.on("data", (chunk) => {
    if (ws && ws.readyState === 1 && clientConnected) {
      try {
        ws.send(Buffer.concat([Buffer.from([0x02]), chunk]), { binary: true });
      } catch {}
    }
  });

  audioProcess.stderr.on("data", () => {
    // Keep quiet unless process exits; ffmpeg prints frequent progress lines.
  });

  audioProcess.on("close", (code) => {
    if (code !== 0 && clientConnected) {
      console.log("Audio capture exited:", code);
      setTimeout(startAudioCapture, 1000);
    }
    audioProcess = null;
  });
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

function handleInput(data) {
  if (!data || !data.action) return;

  switch (data.action) {
    case "mousemove": {
      const absX = Math.round((data.x || 0) * screenWidth);
      const absY = Math.round((data.y || 0) * screenHeight);
      moveMouse(absX, absY);
      break;
    }
    case "mousedown": {
      const absX = Math.round((data.x || 0) * screenWidth);
      const absY = Math.round((data.y || 0) * screenHeight);
      mouseDown(absX, absY, data.button);
      break;
    }
    case "mouseup": {
      const absX = Math.round((data.x || 0) * screenWidth);
      const absY = Math.round((data.y || 0) * screenHeight);
      mouseUp(absX, absY, data.button);
      break;
    }
    case "dblclick":
    {
      const absX = Math.round((data.x || 0) * screenWidth);
      const absY = Math.round((data.y || 0) * screenHeight);
      doubleClick(absX, absY);
      break;
    }
    case "scroll":
      scroll(data.deltaX, data.deltaY);
      break;
    case "keydown":
      keyDown(data);
      break;
    case "keyup":
      break;
  }
}

function moveMouse(x, y) {
  if (mouseBackend === "quartz") {
    const script = `python3 -c "import Quartz; Quartz.CGEventPost(0, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (${x}, ${y}), 0))"`;
    spawn("bash", ["-c", script], { stdio: "ignore" });
    return;
  }
  if (mouseBackend === "cliclick") {
    spawn("cliclick", [`m:${x},${y}`], { stdio: "ignore" });
  }
}

function mouseDown(x, y, button) {
  if (mouseBackend === "quartz") {
    const eventType = button === 2 ? "Quartz.kCGEventRightMouseDown" : "Quartz.kCGEventLeftMouseDown";
    const btnNum = button === 2 ? 1 : 0;
    const script = `python3 -c "import Quartz; Quartz.CGEventPost(0, Quartz.CGEventCreateMouseEvent(None, ${eventType}, (${x}, ${y}), ${btnNum}))"`;
    spawn("bash", ["-c", script], { stdio: "ignore" });
    return;
  }
  if (mouseBackend === "cliclick") {
    if (button === 2) {
      spawn("cliclick", [`rc:${x},${y}`], { stdio: "ignore" });
    } else {
      spawn("cliclick", [`m:${x},${y}`, "dd:."], { stdio: "ignore" });
    }
  }
}

function mouseUp(x, y, button) {
  if (mouseBackend === "quartz") {
    const eventType = button === 2 ? "Quartz.kCGEventRightMouseUp" : "Quartz.kCGEventLeftMouseUp";
    const btnNum = button === 2 ? 1 : 0;
    const script = `python3 -c "import Quartz; Quartz.CGEventPost(0, Quartz.CGEventCreateMouseEvent(None, ${eventType}, (${x}, ${y}), ${btnNum}))"`;
    spawn("bash", ["-c", script], { stdio: "ignore" });
    return;
  }
  if (mouseBackend === "cliclick" && button !== 2) {
    spawn("cliclick", [`m:${x},${y}`, "du:."], { stdio: "ignore" });
  }
}

function doubleClick(x, y) {
  if (useCliclick) {
    spawn("cliclick", [`dc:${x},${y}`], { stdio: "ignore" });
  } else {
    const script = `python3 -c "
import Quartz
p = (${x}, ${y})
for _ in range(2):
  d = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, p, 0)
  u = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, p, 0)
  Quartz.CGEventPost(0, d)
  Quartz.CGEventPost(0, u)
"`;
    spawn("bash", ["-c", script], { stdio: "ignore" });
  }
}

function scroll(deltaX, deltaY) {
  const dy = Math.round(-deltaY / 10);
  const dx = Math.round(-deltaX / 10);
  const script = `python3 -c "import Quartz; Quartz.CGEventPost(0, Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 2, ${dy}, ${dx}))"`;
  spawn("bash", ["-c", script], { stdio: "ignore" });
}

const KEY_MAP = {
  "Enter": 36, "Tab": 48, "Escape": 53, "Backspace": 51, "Delete": 117,
  "ArrowUp": 126, "ArrowDown": 125, "ArrowLeft": 123, "ArrowRight": 124,
  " ": 49, "Shift": 56, "Control": 59, "Alt": 58, "Meta": 55,
  "CapsLock": 57, "F1": 122, "F2": 120, "F3": 99, "F4": 118,
  "F5": 96, "F6": 97, "F7": 98, "F8": 100, "F9": 101, "F10": 109,
  "F11": 103, "F12": 111, "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121
};

const CLICLICK_MAP = {
  "Enter": "return", "Tab": "tab", "Escape": "esc", "Backspace": "delete",
  "Delete": "fwd-delete", "ArrowUp": "arrow-up", "ArrowDown": "arrow-down",
  "ArrowLeft": "arrow-left", "ArrowRight": "arrow-right",
  " ": "space", "Home": "home", "End": "end", "PageUp": "page-up", "PageDown": "page-down",
  "F1": "f1", "F2": "f2", "F3": "f3", "F4": "f4", "F5": "f5", "F6": "f6",
  "F7": "f7", "F8": "f8", "F9": "f9", "F10": "f10", "F11": "f11", "F12": "f12"
};

function keyDown(data) {
  if (useCliclick) {
    if (data.key.length === 1) {
      if (data.meta || data.ctrl) {
        const script = buildModKeyApplescript(data);
        spawn("osascript", ["-e", script], { stdio: "ignore" });
        return;
      }
      spawn("cliclick", [`t:${data.key}`], { stdio: "ignore" });
      return;
    }
    const mapped = CLICLICK_MAP[data.key];
    if (mapped) {
      spawn("cliclick", [`kp:${mapped}`], { stdio: "ignore" });
    }
    return;
  }

  if (data.key.length === 1 && !data.meta && !data.ctrl) {
    const escaped = data.key.replace(/'/g, "'\\''");
    const script = `python3 -c "
import Quartz
src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateCombinedSessionState)
e = Quartz.CGEventCreateKeyboardEvent(src, 0, True)
Quartz.CGEventKeyboardSetUnicodeString(e, 1, '${escaped}')
Quartz.CGEventPost(0, e)
e2 = Quartz.CGEventCreateKeyboardEvent(src, 0, False)
Quartz.CGEventPost(0, e2)
"`;
    spawn("bash", ["-c", script], { stdio: "ignore" });
    return;
  }

  const keycode = KEY_MAP[data.key];
  if (keycode !== undefined) {
    let flags = 0;
    if (data.shift) flags |= 0x20000;
    if (data.ctrl) flags |= 0x40000;
    if (data.alt) flags |= 0x80000;
    if (data.meta) flags |= 0x100000;

    const script = `python3 -c "
import Quartz
src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateCombinedSessionState)
e = Quartz.CGEventCreateKeyboardEvent(src, ${keycode}, True)
Quartz.CGEventSetFlags(e, ${flags})
Quartz.CGEventPost(0, e)
e2 = Quartz.CGEventCreateKeyboardEvent(src, ${keycode}, False)
Quartz.CGEventPost(0, e2)
"`;
    spawn("bash", ["-c", script], { stdio: "ignore" });
    return;
  }

  if (data.meta || data.ctrl) {
    const script = buildModKeyApplescript(data);
    spawn("osascript", ["-e", script], { stdio: "ignore" });
  }
}

function buildModKeyApplescript(data) {
  const mods = [];
  if (data.meta) mods.push("command down");
  if (data.ctrl) mods.push("control down");
  if (data.alt) mods.push("option down");
  if (data.shift) mods.push("shift down");
  const modStr = mods.join(", ");
  const key = data.key.length === 1 ? data.key.toLowerCase() : data.key;
  return `tell application "System Events" to keystroke "${key}" using {${modStr}}`;
}

process.on("SIGINT", () => {
  console.log("Shutting down...");
  stopCapture();
  if (ws) ws.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopCapture();
  if (ws) ws.close();
  process.exit(0);
});

connectSignaling();
