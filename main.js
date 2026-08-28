const { app, BrowserWindow, nativeImage, ipcMain } = require("electron");
const path = require("node:path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 480,
    title: "Audiovisual Materials",
    icon: path.join(__dirname, "build", "icons", "256x256.png"),
    backgroundColor: "#181818", // matches app.html's <meta name="theme-color">
    show: false,
    // The app has no header of its own to sit under a native title-bar row,
    // so a native one is just a bare strip over black content. macOS insets
    // real traffic lights straight onto the dark background instead — no
    // row, no title text. Linux (and Windows) have no equivalent "inset"
    // chrome, so those go fully frameless and get a matching custom bar of
    // our own — see titlebar.js/preload.js.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } }
      : { frame: false }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Keep "Audiovisual Materials" as the OS window title — app.html's own <title>ComArt</title>
  // is left untouched (it's part of the cloned page), so without this Electron's
  // default page-title sync would rename the window to it after load.
  win.on("page-title-updated", (event) => event.preventDefault());

  // Wait for ready-to-show so the window appears already maximized instead of
  // flashing at its default size first.
  win.once("ready-to-show", () => {
    win.maximize();
    win.show();
  });

  // Keep the custom title bar's maximize/restore icon (Linux/Windows only —
  // see titlebar.js) in sync with state changes that don't originate from its
  // own button: the launch-time maximize() above, the OS's own maximize
  // shortcut, or a drag to/from a screen edge.
  const notifyMaximizedChange = () => win.webContents.send("window:maximized-changed", win.isMaximized());
  win.on("maximize", notifyMaximizedChange);
  win.on("unmaximize", notifyMaximizedChange);

  // F11 (Electron's default "Toggle Full Screen" accelerator, from the
  // implicit application menu — this app sets none of its own) hits
  // win.setFullScreen(), which is native OS fullscreen and has no idea our
  // title bar is just a <div> in the page, not real window chrome. Tell the
  // renderer so titlebar.js can hide it — window controls (minimize included)
  // are meaningless once there's no window to see.
  const notifyFullscreenChange = () => win.webContents.send("window:fullscreen-changed", win.isFullScreen());
  win.on("enter-full-screen", notifyFullscreenChange);
  win.on("leave-full-screen", notifyFullscreenChange);

  win.loadFile(path.join(__dirname, "app.html"));

  return win;
}

ipcMain.on("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.on("window:toggle-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle("window:is-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

app.whenReady().then(() => {
  // BrowserWindow's `icon` option only reaches the Windows/Linux taskbar — on
  // macOS the dock icon is read from the packaged .app's Info.plist, which
  // doesn't exist yet in an unpackaged `electron .` dev run. Without this, dev
  // runs show the generic Electron icon in the dock instead of ours.
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, "build", "icon.png")));
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
