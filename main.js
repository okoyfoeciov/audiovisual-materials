const { app, BrowserWindow, nativeImage } = require("electron");
const path = require("node:path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 480,
    title: "Audio Materials",
    icon: path.join(__dirname, "build", "icons", "256x256.png"),
    backgroundColor: "#181818", // matches app.html's <meta name="theme-color">
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Keep "Audio Materials" as the OS window title — app.html's own <title>ComArt</title>
  // is left untouched (it's part of the cloned page), so without this Electron's
  // default page-title sync would rename the window to it after load.
  win.on("page-title-updated", (event) => event.preventDefault());

  win.loadFile(path.join(__dirname, "app.html"));

  return win;
}

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
