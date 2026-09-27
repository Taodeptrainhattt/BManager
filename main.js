const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow;
const STORE_PATH = path.join(app.getPath('userData'), 'bmanager-store.json');

// ---------- Store helpers ----------
function defaultStore() {
  return {
    username: '',
    settings: {
      cardsPerRow: 4,
      background: {
        colors: ['#0b0c10'], // 1-3 colors; 1 = solid, 2-3 = blended gradient
        angle: 135,           // gradient angle, used when more than 1 color is set
        image: null,          // optional background photo (data URL), tinted by the colors above
        posX: 50,             // visible region of the photo (0-100, drag-to-pick in Settings)
        posY: 50,
        zoom: 100              // 100-250, how far zoomed in on that region
      },
      soundEnabled: true
    },
    folders: [] // { id, name, dirPath, note, files: [{id, name, filePath, note}] }
  };
}

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      const merged = { ...defaultStore(), ...parsed };
      merged.settings = { ...defaultStore().settings, ...(parsed.settings || {}) };
      const oldBg = parsed.settings && parsed.settings.background;
      if (oldBg) {
        const cnt = oldBg.count || (oldBg.colors ? oldBg.colors.length : 1);
        const colors = (oldBg.colors || ['#0b0c10']).slice(0, Math.min(3, Math.max(1, cnt)));
        merged.settings.background = {
          colors, angle: oldBg.angle || 135, image: oldBg.image || null,
          posX: oldBg.posX != null ? oldBg.posX : 50,
          posY: oldBg.posY != null ? oldBg.posY : 50,
          zoom: oldBg.zoom || 100
        };
      } else {
        merged.settings.background = defaultStore().settings.background;
      }
      return merged;
    }
  } catch (e) {
    console.error('Failed to read store:', e);
  }
  return defaultStore();
}

function saveStore(store) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to write store:', e);
    return false;
  }
}

// ---------- Scan .js files ----------
function scanJsFiles(dirPath) {
  const results = [];
  function walk(current, depth) {
    if (depth > 4) return; // depth limit to keep scans fast
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.js')) {
        results.push(full);
      }
    }
  }
  walk(dirPath, 0);
  return results;
}

// ---------- Window ----------
function resolveIndexHtml() {
  const candidates = [
    path.join(__dirname, 'src', 'index.html'),
    path.join(__dirname, 'index.html')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0b0c10',
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);

  const indexPath = resolveIndexHtml();
  if (!indexPath) {
    dialog.showErrorBox(
      'BManager - index.html not found',
      'Could not find index.html in either:\n' +
      '  ' + path.join(__dirname, 'src', 'index.html') + '\n' +
      '  ' + path.join(__dirname, 'index.html') + '\n\n' +
      'Make sure index.html, style.css and renderer.js are placed together in one of these locations.'
    );
    app.quit();
    return;
  }
  mainWindow.loadFile(indexPath);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC: store ----------
ipcMain.handle('store:get', () => loadStore());
ipcMain.handle('store:set', (evt, store) => saveStore(store));

// ---------- IPC: pick a directory and scan for .js files ----------
ipcMain.handle('folder:choose-and-scan', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) {
    return { canceled: true };
  }
  const dirPath = res.filePaths[0];
  const files = scanJsFiles(dirPath);
  if (files.length === 0) {
    return { canceled: false, empty: true, dirPath };
  }
  return { canceled: false, empty: false, dirPath, files };
});

// ---------- IPC: pick individual .js files to add to a folder ----------
ipcMain.handle('folder:add-files', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'JavaScript', extensions: ['js'] }]
  });
  if (res.canceled || res.filePaths.length === 0) return { canceled: true };
  return { canceled: false, files: res.filePaths };
});

// ---------- IPC: run a .js file ----------
const runningProcesses = {}; // fileId -> child process

// Chatty bots can emit stdout in many tiny chunks per second. Sending one
// IPC message per chunk adds up fast over hours of runtime, so we buffer
// each process's output and flush it in small batches instead.
const outputBuffers = {}; // fileId -> accumulated string awaiting flush
const OUTPUT_FLUSH_MS = 80;
const OUTPUT_FLUSH_HARD_CAP = 200000; // force-flush if a single burst gets huge

function bufferOutput(fileId, text) {
  outputBuffers[fileId] = (outputBuffers[fileId] || '') + text;
  if (outputBuffers[fileId].length > OUTPUT_FLUSH_HARD_CAP) flushOutput(fileId);
}

function flushOutput(fileId) {
  const text = outputBuffers[fileId];
  if (!text) return;
  outputBuffers[fileId] = '';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('process:output', { fileId, data: text });
  }
}

setInterval(() => {
  Object.keys(outputBuffers).forEach(flushOutput);
}, OUTPUT_FLUSH_MS);

ipcMain.handle('process:run', (evt, { fileId, filePath }) => {
  if (runningProcesses[fileId]) {
    return { ok: false, message: 'This file is already running.' };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, message: 'File not found on disk.' };
  }
  let child;
  try {
    child = spawn(process.platform === 'win32' ? 'node.exe' : 'node', [filePath], {
      cwd: path.dirname(filePath)
    });
  } catch (e) {
    return { ok: false, message: 'Could not start process: ' + e.message };
  }
  runningProcesses[fileId] = child;

  const send = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, { fileId, data });
    }
  };

  send('process:status', 'running');
  child.stdout.on('data', (d) => bufferOutput(fileId, d.toString()));
  child.stderr.on('data', (d) => bufferOutput(fileId, d.toString()));
  child.on('close', (code) => {
    bufferOutput(fileId, `\n[process exited with code ${code}]\n`);
    flushOutput(fileId);
    send('process:status', 'stopped');
    delete runningProcesses[fileId];
  });
  child.on('error', (err) => {
    bufferOutput(fileId, `\n[error: ${err.message}]\n`);
    flushOutput(fileId);
    send('process:status', 'stopped');
    delete runningProcesses[fileId];
  });

  return { ok: true };
});

ipcMain.handle('process:stop', (evt, { fileId }) => {
  const child = runningProcesses[fileId];
  if (child) {
    child.kill();
    delete runningProcesses[fileId];
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle('process:send-input', (evt, { fileId, text }) => {
  const child = runningProcesses[fileId];
  if (child && child.stdin.writable) {
    child.stdin.write(text + '\n');
    return { ok: true };
  }
  return { ok: false };
});


