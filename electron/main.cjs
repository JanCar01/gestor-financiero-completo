const { app, BrowserWindow, dialog, shell, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let local;
let quitting = false;

function openNotion(url) {
  try {
    const target = new URL(url);
    if (target.protocol === 'https:' && !target.username && !target.password &&
        (target.hostname === 'notion.so' || target.hostname.endsWith('.notion.so') || target.hostname === 'notion.site' || target.hostname.endsWith('.notion.site'))) {
      void shell.openExternal(target.href).catch(() => dialog.showErrorBox('Abrir Notion', 'No se pudo abrir el navegador.'));
    }
  } catch { /* Ignorar enlaces inválidos. */ }
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1000, minHeight: 650,
    backgroundColor: '#ffffff', show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const authorized = url => {
    try { return new URL(url).origin === local.url; } catch { return false; }
  };
  win.webContents.on('will-navigate', event => {
    if (!authorized(event.url)) { event.preventDefault(); openNotion(event.url); }
  });
  win.webContents.on('will-frame-navigate', event => {
    if (!authorized(event.url)) event.preventDefault();
  });
  win.webContents.on('will-redirect', event => {
    if (!authorized(event.url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { openNotion(url); return { action: 'deny' }; });
  await win.loadURL(local.url);
  win.show();
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win?.isMinimized()) win.restore();
  win?.focus();
});

if (hasLock) app.whenReady().then(async () => {
  try {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const { startServer } = await import(pathToFileURL(path.join(__dirname, '../server/index.js')).href);
    // La configuración viaja dentro de app.asar, también en el portable.
    const directory = app.getAppPath();
    local = await startServer({ envPath: path.join(directory, '.env'), quoteCacheDir: path.join(app.getPath('userData'), 'valoraciones') });
    if (quitting) { await local.close(); return; }
    await createWindow();
  } catch (err) {
    const message = err.code ? `No se pudo iniciar el servidor local (${err.code}). Comprueba los permisos de la aplicación.` :
      err.message?.startsWith('Falta configurar') || err.message?.startsWith('No se puede leer') ? err.message : 'No se pudo abrir el dashboard. Comprueba los archivos de la aplicación.';
    dialog.showErrorBox('Gestor Financiero — Error de arranque', message);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  quitting = true;
  if (local) {
    event.preventDefault();
    void local.close().catch(() => {}).finally(() => app.quit());
  }
});
