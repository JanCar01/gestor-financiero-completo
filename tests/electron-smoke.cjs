// Ejecutar con Electron tras npm run build. No consulta Notion ni usa credenciales reales.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const directory = path.resolve(__dirname, '../.verify/electron');
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', directory);
app.setPath('sessionData', directory);
app.setPath('crashDumps', directory);
app.setAppPath(directory);
fs.writeFileSync(path.join(directory, '.env'), 'NOTION_TOKEN=test-only\nNOTION_MOVIMIENTOS_DATABASE_ID=movements\nNOTION_CUENTAS_DATABASE_ID=accounts\nNOTION_FONDOS_DATABASE_ID=funds\n');
const originalFetch = global.fetch;
const title = name => ({ type: 'title', title: [{ plain_text: name }] });
const number = value => ({ type: 'number', number: value });
const fund = (isin, name, shares, cost) => ({ id: isin, properties: {
  Fondo: title(name), ISIN: { type: 'rich_text', rich_text: [{ plain_text: isin }] },
  Participaciones: number(shares), 'Coste de adquisición': number(cost), Divisa: { type: 'select', select: { name: 'EUR' } }
} });
global.fetch = async (url, options) => {
  const target = new URL(url);
  if (target.hostname === 'api.notion.com') {
    if (options.method === 'GET') return Response.json({ properties: { Tipo: { select: { options: [{ name: 'Alquiler' }] } } } });
    const results = target.pathname.includes('/funds/') ? [
      fund('IE00BYX5NX33', 'Fondo mundial', 10, 900), fund('IE0031786142', 'Fondo emergente', 4, 1100)
    ] : target.pathname.includes('/accounts/') ? [{ id: 'portfolio', properties: { Cuenta: title('MyInvestor'), 'Saldo inicial': number(2000) } }] : [];
    return Response.json({ results, has_more: false });
  }
  if (target.hostname === 'www.quefondos.com') {
    const world = target.searchParams.get('isin') === 'IE00BYX5NX33';
    return new Response(`<div><h4>Última valoración</h4>
      <p><span class="floatleft">Valor liquidativo:</span><span class="floatright">${world ? 100 : 300},00 EUR</span></p>
      <p><span class="floatleft">Fecha:</span><span class="floatright">24/11/2026</span></p>
      <p><span class="floatleft">1 día:</span><span class="floatright">${world ? '-0,84' : '2,84'}%</span></p></div>`);
  }
  if (['www.es.vanguard', 'www.finect.com'].includes(target.hostname)) return new Response(null, { status: 503 });
  return originalFetch(url, options);
};
const report = path.join(directory, 'result.json');
fs.rmSync(report, { force: true });
const timeout = setTimeout(() => {
  fs.writeFileSync(report, JSON.stringify({ error: 'Electron no completó el arranque en 25 segundos.' }));
  app.exit(1);
}, 25000);
dialog.showErrorBox = (_title, message) => {
  fs.writeFileSync(report, JSON.stringify({ error: message }));
  clearTimeout(timeout);
  app.exit(1);
};
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => {
    setImmediate(async () => {
      try {
        const url = new URL(win.webContents.getURL()).origin;
        assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
        const preferences = win.webContents.getLastWebPreferences();
        assert.equal(preferences.contextIsolation, true);
        assert.equal(preferences.nodeIntegration, false);
        assert.equal(preferences.sandbox, true);
        for (const route of ['movimientos', 'cuentas', 'fondos', 'pagos']) {
          const response = await originalFetch(`${url}/api/${route}`, { method: 'POST' });
          assert.equal(response.status, 200);
          assert.equal((await response.json()).status, 'success');
        }
        assert.equal(await win.webContents.executeJavaScript('typeof require'), 'undefined');
        const dashboard = await win.webContents.executeJavaScript(`new Promise(resolve => {
          const check = () => {
            if (document.querySelectorAll('.fund-row').length === 2 && !document.querySelector('.primary-btn').disabled) {
              observer.disconnect();
              resolve(document.body.innerText);
            }
          };
          const observer = new MutationObserver(check);
          observer.observe(document.body, { childList: true, subtree: true, attributes: true });
          check();
        })`);
        assert.match(dashboard, /Tu dinero, más claro/);
        assert.match(dashboard, /Tus inversiones/);
        assert.match(dashboard, /Pagos previstos/);
        assert.match(dashboard, /Registrar operación/);
        assert.match(dashboard, /2\.?200,00\s*€/);
        assert.match(dashboard, /\+200,00\s*€/);
        assert.match(dashboard, /\+10,00\s*%/);
        assert.match(dashboard, /Baja -0,84\s*%/);
        assert.match(dashboard, /Sube \+2,84\s*%/);
        assert.match(dashboard, /24\/11\/2026 · Quefondos/);
        assert.doesNotMatch(dashboard, /HTTP 503|falló la consulta/);
        assert.doesNotMatch(dashboard, /Evolución de tus gastos|Flujo neto|Aportado a inversión/);
        const event = { preventDefault() { this.blocked = true; } };
        win.webContents.emit('will-frame-navigate', Object.assign(event, { url: 'https://example.com' }));
        assert.equal(event.blocked, true);
        fs.writeFileSync(report, JSON.stringify({ url, startup: true, api: true, sandbox: true }));
        clearTimeout(timeout);
        win.close();
      } catch (error) {
        fs.writeFileSync(report, JSON.stringify({ error: error.message }));
        clearTimeout(timeout);
        app.exit(1);
      }
    });
  });
});
app.on('will-quit', () => {
  if (fs.existsSync(report)) {
    const result = JSON.parse(fs.readFileSync(report, 'utf8'));
    fs.writeFileSync(report, JSON.stringify({ ...result, shutdown: true, windows: BrowserWindow.getAllWindows().length }));
  }
});
require('../electron/main.cjs');
