const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

const SIGNAL_SERVER = process.env.SIGNAL_SERVER || "ws://localhost:3000";
const ROOM = process.env.ROOM || "default";
const PASSWORD = process.env.ROOM_PASSWORD || "changeme";
const FPS = parseInt(process.env.FPS || "15", 10);
const QUALITY = parseInt(process.env.QUALITY || "5", 10);
const SCALE = process.env.SCALE || "1280:-1";

let screenWidth = 1920;
let screenHeight = 1080;

try {
  const sizeStr = execSync(
    `system_profiler SPDisplaysDataType | grep Resolution | head -1 | awk '{print $2, $4}'`,
    { encoding: "utf8" }
  ).trim();
  const parts = sizeStr.split(/\s+/);
  if (parts.length === 2) {
    screenWidth = parseInt(parts[0], 10);
    screenHeight = parseInt(parts[1], 10);
  }
} catch {}

console.log(`Screen: ${screenWidth}x${screenHeight}`);
console.log(`Server: ${SIGNAL_SERVER}`);
console.log(`FPS: ${FPS}, Quality: ${QUALITY}, Scale: ${SCALE}`);

let ws = null;
let ffmpegProcess = null;
let connected = false;
let clientConnected = false;

function hasCliclick() {
  try {
    execSync("which cliclick", { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

const useCliclick = hasCliclick();
console.log(useCliclick ? "Input: cliclick" : "Input: osascript/python (install cliclick for better perf)");

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

  const args = [
    "-f", "avfoundation",
    "-capture_cursor", "1",
    "-framerate", String(FPS),
    "-i", "1:none",
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
    const line = data.toString().trim();
    if (line && !line.startsWith("frame=") && !line.startsWith("  ") && !line.includes("encoder")) {
    }
  });

  ffmpegProcess.on("close", (code) => {
    console.log("ffmpeg exited:", code);
    ffmpegProcess = null;
    if (clientConnected) {
      setTimeout(startCapture, 1000);
    }
  });
}

function sendFrame(frame) {
  if (ws && ws.readyState === 1 && clientConnected) {
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
  if (useCliclick) {
    spawn("cliclick", [`m:${x},${y}`], { stdio: "ignore" });
  } else {
    const script = `python3 -c "import Quartz; Quartz.CGEventPost(0, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (${x}, ${y}), 0))"`;
    spawn("bash", ["-c", script], { stdio: "ignore" });
  }
}

function mouseDown(x, y, button) {
  if (useCliclick) {
    if (button === 2) {
      spawn("cliclick", [`rc:${x},${y}`], { stdio: "ignore" });
    } else {
      // Use down/up events so drag and hold actions work.
      spawn("cliclick", [`m:${x},${y}`, "dd:."], { stdio: "ignore" });
    }
  } else {
    const eventType = button === 2 ? "Quartz.kCGEventRightMouseDown" : "Quartz.kCGEventLeftMouseDown";
    const btnNum = button === 2 ? 1 : 0;
    const script = `python3 -c "import Quartz; Quartz.CGEventPost(0, Quartz.CGEventCreateMouseEvent(None, ${eventType}, (${x}, ${y}), ${btnNum}))"`;
    spawn("bash", ["-c", script], { stdio: "ignore" });
  }
}

function mouseUp(x, y, button) {
  if (useCliclick) {
    if (button !== 2) {
      spawn("cliclick", [`m:${x},${y}`, "du:."], { stdio: "ignore" });
    }
    return;
  }

  const eventType = button === 2 ? "Quartz.kCGEventRightMouseUp" : "Quartz.kCGEventLeftMouseUp";
  const btnNum = button === 2 ? 1 : 0;
  const script = `python3 -c "import Quartz; Quartz.CGEventPost(0, Quartz.CGEventCreateMouseEvent(None, ${eventType}, (${x}, ${y}), ${btnNum}))"`;
  spawn("bash", ["-c", script], { stdio: "ignore" });
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
