// ELECTRON, OUT OF ELECTRON. `require('electron')` in a plain Node process returns the path to the binary,
// not the API, so every main-process test died on `ipcMain.handle is not a function` — 3 of the 5 desktop
// tests. This is the smallest stand-in that lets the REAL MainProcess run: it records what the code under
// test registers (ipc handlers, windows, tray items) instead of faking success, so a test can assert against
// what actually happened. It is a test double, never loaded by Electron itself.
const handlers = new Map();
const windows = [];

let nextWindowId = 1;
class BrowserWindow {
  constructor(opts = {}) {
    this.id = nextWindowId++;   // Electron assigns one; code keys its window map by it
    this.opts = opts;
    this.webContents = { send: (channel, ...args) => { this.sent.push({ channel, args }); }, openDevTools() {} };
    this.sent = [];
    this.loaded = null;
    this.shown = false;
    windows.push(this);
  }
  loadFile(p) { this.loaded = p; return Promise.resolve(); }
  loadURL(u) { this.loaded = u; return Promise.resolve(); }
  show() { this.shown = true; }
  hide() { this.shown = false; }
  on() { return this; }
  once() { return this; }
  static getAllWindows() { return windows.slice(); }
}

class Tray {
  constructor(icon) { this.icon = icon; this.menu = null; this.tooltip = null; }
  setContextMenu(m) { this.menu = m; }
  setToolTip(t) { this.tooltip = t; }
  on() { return this; }
}

module.exports = {
  app: {
    whenReady: () => Promise.resolve(),
    on() { return this; },
    once() { return this; },
    quit() { this.quitCalled = true; },
    getPath: (name) => `/tmp/xmbl-desktop-test/${name}`,
    getVersion: () => '0.1.0',
    isPackaged: false,
  },
  BrowserWindow,
  Tray,
  Menu: { buildFromTemplate: (template) => ({ template }), setApplicationMenu() {} },
  ipcMain: {
    handle: (channel, fn) => { handlers.set(channel, fn); },
    on: (channel, fn) => { handlers.set(channel, fn); },
    removeHandler: (channel) => handlers.delete(channel),
    _handlers: handlers,      // what the code under test actually registered
  },
  contextBridge: { exposeInMainWorld() {} },
  ipcRenderer: { invoke: () => Promise.resolve(), on() {}, removeListener() {} },
  _test: { handlers, windows },
};
