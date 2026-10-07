/**
 * Bops for Mac. A native window around the Bops app: it starts the app's local server if one
 * isn't already running, opens the window with the Mac title bar from the design, and on quit
 * stops what it started, including the bots' background browsers.
 */
const { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, Notification, screen, shell, systemPreferences } = require("electron");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const PORT = 3210;
const URL = `http://localhost:${PORT}`;
const win = process.platform === "win32";
const mac = process.platform === "darwin";
const REPO = (() => {
  try {
    return require("./repo.json").path;
  } catch {
    return path.resolve(__dirname, "..");
  }
})();
const ICON = path.join(__dirname, "icon.png");

let server;
let mainWin;
let pipWin;

/** Apps opened from Finder get a bare PATH; borrow the login shell's so node and codex resolve. */
function loginPath() {
  if (win) return process.env.PATH || "";
  try {
    return execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf %s "$PATH"'], { timeout: 5000 }).toString();
  } catch {
    return process.env.PATH || "";
  }
}

/** Bops' server is answering. /api/health imports nothing, so a missing key can't hold up the start. */
async function serverUp() {
  try {
    return (await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** Something already listens on the port (a server from an earlier start that's still loading, say). */
function portTaken() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => (s.destroy(), resolve(false)));
  });
}

/*
 * Where the server runs from. A release build carries a prebuilt server (Next's standalone output,
 * copied to Resources/server by electron-builder) and runs it with the app's own Node. A build made
 * with `npm run app:build` (desktop/repo.json) or `npm run app` runs `next dev` in the source folder.
 */
function packagedServer() {
  if (!app.isPackaged || fs.existsSync(path.join(__dirname, "repo.json"))) return null;
  const dir = path.join(process.resourcesPath, "server");
  if (!fs.existsSync(path.join(dir, "server.js"))) return null;
  // The app bundle is read-only (and sealed by its signature), but the server keeps its state in
  // .data/ under its working folder and reads vm/ and node_modules/ from there. So it runs in
  // ~/Library/Application Support/Bops/server, where everything but .data links into the bundle.
  const home = path.join(app.getPath("userData"), "server");
  fs.mkdirSync(path.join(home, ".data"), { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name === ".data" || name.startsWith(".env")) continue;
    const link = path.join(home, name);
    const st = fs.lstatSync(link, { throwIfNoEntry: false });
    // macOS keeps an existing real file alone. On Windows a real file/directory may be our
    // symlink-permission fallback copy from an older app version, so refresh it from this build.
    if (st && !st.isSymbolicLink() && !win) continue;
    if (st && st.isSymbolicLink() && fs.readlinkSync(link) === path.join(dir, name)) continue;
    if (st) fs.rmSync(link, { recursive: true, force: true });
    if (win) {
      const src = path.join(dir, name);
      const kind = fs.statSync(src).isDirectory() ? "junction" : "file";
      try { fs.symlinkSync(src, link, kind); }
      catch {
        if (kind === "junction") fs.cpSync(src, link, { recursive: true, force: true });
        else fs.copyFileSync(src, link);
      }
    } else {
      fs.symlinkSync(path.join(dir, name), link);
    }
  }
  // Per-machine self-hosting/testing settings live in the platform's Bops user-data folder as .env.local;
  // the app itself ships with no keys.
  let env = {};
  try {
    env = require("node:util").parseEnv(fs.readFileSync(path.join(app.getPath("userData"), ".env.local"), "utf8"));
  } catch {}
  const relay = [path.join(process.resourcesPath, "bin", "orgo-relay.exe"), path.join(process.resourcesPath, "bin", "orgo-relay")].find((p) => fs.existsSync(p));
  // What the server prints, for support: ~/Library/Logs/Bops/server.log. Each start adds to it (an
  // earlier start's error is often the one that matters); it starts over once it passes 5 MB.
  fs.mkdirSync(app.getPath("logs"), { recursive: true });
  const logFile = path.join(app.getPath("logs"), "server.log");
  const big = (fs.statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > 5 * 1024 * 1024;
  const log = fs.openSync(logFile, big ? "w" : "a");
  fs.writeSync(log, `\n--- Bops ${app.getVersion()} starting, ${new Date().toISOString()}\n`);
  return { dir, home, log, env: { ...env, ...(relay ? { BOPS_RELAY_BIN: relay } : {}) } };
}

async function startServer() {
  if (await serverUp()) return;
  // A second server on a taken port only fails (EADDRINUSE): wait for the one that's there instead.
  if (await portTaken()) {
    for (let i = 0; i < 240 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 500));
    return;
  }
  const packaged = packagedServer();
  server = packaged
    ? // Run as Node by the app's own binary. server.js changes into its folder on start; keeping the
      // working folder in Application Support is what lets the server write its state.
      spawn(process.execPath, ["-e", "process.chdir = () => {}; require(process.env.BOPS_SERVER_JS)"], {
        cwd: packaged.home,
        env: {
          ...process.env,
          ...packaged.env,
          PATH: loginPath(),
          ELECTRON_RUN_AS_NODE: "1",
          BOPS_SERVER_JS: path.join(packaged.dir, "server.js"),
          NODE_ENV: "production",
          // The server exits on SIGTERM itself, after its last work (the state saved, and backed up to Bops Cloud).
          NEXT_MANUAL_SIG_HANDLE: "true",
          PORT: String(PORT),
          // Only this Mac can reach the bundled server, unless its settings say BOPS_LISTEN_ALL=1:
          // bot computers' app calls and phone webhooks reach Bops over the tailnet, so they need
          // it (proxy.ts then lets other addresses reach only those paths).
          HOSTNAME: packaged.env.BOPS_LISTEN_ALL === "1" ? "0.0.0.0" : "127.0.0.1",
        },
        stdio: ["ignore", packaged.log, packaged.log],
        detached: !win,
      })
    : spawn(win ? "npx.cmd" : "npx", ["next", "dev", "--port", String(PORT)], {
        cwd: REPO,
        env: { ...process.env, PATH: loginPath() },
        stdio: "ignore",
        detached: !win,
      });
  for (let i = 0; i < 240 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 500));
}

const splash = `data:text/html,${encodeURIComponent(`<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:13px -apple-system,system-ui;color:#6B6B6B;-webkit-app-region:drag">Starting Bops…</body>`)}`;

async function createWindow() {
  const options = {
    width: 1360,
    height: 860,
    minWidth: 1180,
    minHeight: 640,
    title: "Bops",
    backgroundColor: "#FFFFFF",
    icon: ICON,
    webPreferences: { webviewTag: true, preload: path.join(__dirname, "preload.cjs") },
  };
  if (mac) {
    options.titleBarStyle = "hiddenInset";
    options.trafficLightPosition = { x: 14, y: 14 };
  }
  const appWindow = new BrowserWindow(options);
  mainWin = appWindow;
  appWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  await appWindow.loadURL(splash);
  await startServer();
  await appWindow.loadURL(URL);
}

// A page in a tab that opens a new window opens it in your browser instead.
app.on("web-contents-created", (_, contents) => {
  if (contents.getType() !== "webview") return;
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
});

/*
 * Screen Recording. macOS only answers "granted" or "denied" here, never "not asked yet", and it
 * only lists an app under Screen Recording (and shows its prompt) once the app has tried to capture.
 * So Bops remembers in its data folder that it has asked, and until then reports "not-determined"
 * so the page offers Allow; asking is trying to list the screens.
 */
const screenAskedFile = () => path.join(app.getPath("userData"), "screen-asked.json");
function screenAsked() {
  try {
    return fs.existsSync(screenAskedFile());
  } catch {
    return false;
  }
}
function screenStatus() {
  if (process.platform !== "darwin") return "granted";
  const access = systemPreferences.getMediaAccessStatus("screen");
  return access !== "granted" && !screenAsked() ? "not-determined" : access;
}
async function askScreen() {
  if (process.platform !== "darwin" || systemPreferences.getMediaAccessStatus("screen") === "granted") return;
  try {
    fs.writeFileSync(screenAskedFile(), JSON.stringify({ at: Date.now() }));
  } catch {}
  await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
}

/*
 * Your Mac, live. The page asks for the displays and windows it can show, then streams one with
 * getUserMedia (chromeMediaSource "desktop"). macOS asks the user once to allow Screen Recording.
 */
ipcMain.handle("mac-screens", async () => {
  // The first time, ask: that lists Bops under Screen Recording and shows macOS's prompt.
  if (screenStatus() === "not-determined") await askScreen();
  const access = screenStatus();
  const displays = screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: d.label || (d.internal ? "Built-in display" : `Display ${i + 1}`),
    width: d.size.width,
    height: d.size.height,
    primary: d.id === screen.getPrimaryDisplay().id,
  }));
  // The display Bops is on: showing it shows Bops inside Bops, so the tab prefers another.
  const win = BrowserWindow.getAllWindows()[0];
  const bopsOn = mainWin ? String(screen.getDisplayMatching(mainWin.getBounds()).id) : undefined;
  if (access !== "granted") return { access, displays, sources: [], bopsOn };
  const list = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
  return { access, displays, bopsOn, sources: list.map((s) => ({ id: s.id, name: s.name, displayId: s.display_id || undefined })) };
});
ipcMain.handle("mac-screen-settings", () =>
  win ? shell.openExternal("ms-settings:privacy-screenshots") : shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"),
);

/*
 * What Bops asks macOS for, all in one place (components/app/setup.tsx, and Settings → This Mac):
 * Screen Recording (to show your Mac live), the Microphone (calls with bots) and Notifications.
 * Bops itself never reads or drives other apps' windows: computer use on your Mac runs in its own
 * app, which asks for Accessibility itself, so Accessibility is only read here, never prompted for
 * from setup.
 */
const PANES = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  notifications: "x-apple.systempreferences:com.apple.preference.notifications",
};
const PERM_IDS = Object.keys(PANES);
// macOS keeps the Screen Recording answer a process saw at launch: a grant made later only takes
// effect after a restart. The status at launch tells the page when to offer one.
const screenAtLaunch = mac ? systemPreferences.getMediaAccessStatus("screen") : "granted";

/*
 * Notifications: Electron can't read macOS's answer, only learn it by showing one (it asks the first
 * time; "failed" means not allowed). The last answer is kept in the app's data folder. It goes stale
 * if the user changes it in System Settings later, so the page treats it as a hint.
 */
const notifyFile = () => path.join(app.getPath("userData"), "notifications.json");
function notifyKnown() {
  try {
    return JSON.parse(fs.readFileSync(notifyFile(), "utf8")).status;
  } catch {
    return undefined;
  }
}
function notifyStatus() {
  if (!Notification.isSupported()) return "restricted";
  return notifyKnown() ?? "not-determined";
}
function askNotify() {
  if (!Notification.isSupported()) return Promise.resolve("restricted");
  return new Promise((resolve) => {
    const done = (status) => {
      clearTimeout(timer);
      // No answer yet (the prompt is still up): don't remember a guess.
      if (status !== "not-determined") {
        try {
          fs.writeFileSync(notifyFile(), JSON.stringify({ status, at: Date.now() }));
        } catch {}
      }
      resolve(status);
    };
    const n = new Notification({ title: "Bops", body: "Your bots can tell you when something needs you.", silent: true });
    n.once("show", () => done("granted"));
    n.once("failed", () => done("denied"));
    const timer = setTimeout(() => done(notifyKnown() ?? "not-determined"), 30_000);
    n.show();
  });
}

function permStatus(id) {
  if (win) {
    if (id === "notifications") return notifyStatus();
    if (id === "microphone") {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      return status === "unknown" ? "not-determined" : status;
    }
    // Windows desktop capture and UI Automation do not use a macOS-style app grant.
    if (id === "screen" || id === "accessibility") return "granted";
    return "unknown";
  }
  if (!mac) return id === "notifications" ? notifyStatus() : "granted";
  if (id === "screen") return screenStatus();
  if (id === "microphone") return systemPreferences.getMediaAccessStatus(id);
  if (id === "accessibility") return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "not-determined";
  if (id === "notifications") return notifyStatus();
  return "unknown";
}

ipcMain.handle("perm-status", () => Object.fromEntries(PERM_IDS.map((id) => [id, permStatus(id)])));
ipcMain.handle("perm-request", async (_, id) => {
  if (!PERM_IDS.includes(id)) return "unknown";
  if (win) {
    if (id === "notifications") return askNotify();
    if (id === "microphone") {
      const status = permStatus(id);
      if (status !== "granted") await shell.openExternal("ms-settings:privacy-microphone");
      return status;
    }
    return "granted";
  }
  if (!mac) return id === "notifications" ? askNotify() : "granted";
  if (id === "microphone") {
    await systemPreferences.askForMediaAccess("microphone").catch(() => false);
  } else if (id === "screen") {
    // Asking for the screens is what makes macOS list Bops under Screen Recording and show its prompt.
    await askScreen();
  } else if (id === "accessibility") {
    systemPreferences.isTrustedAccessibilityClient(true);
  } else if (id === "notifications") {
    return askNotify();
  }
  return permStatus(id);
});
ipcMain.handle("perm-settings", (_, id) => {
  if (win) {
    const pages = { screen: "ms-settings:privacy-screenshots", microphone: "ms-settings:privacy-microphone", notifications: "ms-settings:notifications", accessibility: "ms-settings:easeofaccess" };
    return pages[id] ? shell.openExternal(pages[id]) : undefined;
  }
  return PANES[id] ? shell.openExternal(PANES[id]) : undefined;
});
// Screen Recording was turned on after Bops started: it works once Bops restarts.
ipcMain.handle("perm-screen-restart", () => mac && screenAtLaunch !== "granted" && systemPreferences.getMediaAccessStatus("screen") === "granted");
// Stop the server first and wait for its port to close, so the new Bops starts its own instead of
// finding the old one still answering and then losing it.
ipcMain.handle("relaunch", async () => {
  if (stopServer()) for (let i = 0; i < 40 && (await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  app.relaunch();
  app.quit();
});

/*
 * The Mac previews, popped out: a small window that floats over every app and every Space. Drag it
 * by its bar, resize it; closing it puts the previews back in the corner of Bops.
 */
ipcMain.handle("mac-pip-open", () => {
  if (pipWin && !pipWin.isDestroyed()) return pipWin.focus();
  const area = screen.getDisplayMatching(mainWin?.getBounds() ?? { x: 0, y: 0, width: 1, height: 1 }).workArea;
  pipWin = new BrowserWindow({
    width: 300,
    height: 420,
    minWidth: 220,
    minHeight: 180,
    x: area.x + area.width - 320,
    y: area.y + 60,
    frame: false,
    resizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: "#F2F2F0",
    title: win ? "Your PC" : "Your Mac",
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  pipWin.setAlwaysOnTop(true, "floating");
  pipWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void pipWin.loadURL(`${URL}/pip`);
  pipWin.on("closed", () => (pipWin = undefined));
});
ipcMain.handle("mac-pip-close", () => pipWin?.close());
ipcMain.handle("mac-show-main", () => {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
});

app.setName("Bops");
app.whenReady().then(() => {
  if (win) app.setAppUserModelId("ai.orgo.bops");
  if (process.platform === "darwin" && fs.existsSync(ICON)) app.dock.setIcon(nativeImage.createFromPath(ICON));
  void createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && void createWindow());
});

app.on("window-all-closed", () => app.quit());

/** Stops the server Bops started (and the bots' browsers). Says whether there was one. */
function stopServer() {
  if (!server) return false;
  try {
    if (win) execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-server.pid);
  } catch {}
  server = undefined;
  if (!win) {
    try { execFileSync("pkill", ["-f", ".bops/chrome/"]); } catch {}
  }
  return true;
}

app.on("will-quit", () => void stopServer());
