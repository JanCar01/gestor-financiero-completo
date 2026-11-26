import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { createQuoteLookup } from './fund-quotes.js';
import { divisaValida, isinValido } from './quote-format.js';
import { createNotionClient, numeric, plain, property } from './notion.js';
import { createPayments } from './payments.js';
import { createFundOperations, valuePositions } from './fund-operations.js';
import { WorkflowError } from './workflow.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const required = ['NOTION_TOKEN', 'NOTION_MOVIMIENTOS_DATABASE_ID', 'NOTION_CUENTAS_DATABASE_ID'];
const defaultFundsDb = '424e79e9-3d2d-81f4-8dc2-f6a6ecca9248';
const defaultPaymentsDb = '424e79e9-3d2d-8101-92cc-f3cde387bff7';
const defaultOperationsDb = '424e79e9-3d2d-8185-ac18-c2dda933273b';
const isMyInvestor = name => /my\s*investor/i.test(name);

export function loadConfiguration(envPath = path.resolve(root, '../.env')) {
  let external = {};
  try { external = parseEnv(readFileSync(envPath, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`No se puede leer la configuración: ${envPath}`);
  }
  const config = { ...process.env, ...external };
  const missing = required.filter(key => !config[key]?.trim());
  if (missing.length) throw new Error(`Falta configurar ${missing.join(', ')}. Revisa el archivo ${envPath}`);
  return config;
}

// Importar este módulo no abre sockets ni carga credenciales.
export async function startServer({ port = 0, envPath, config = loadConfiguration(envPath), allowedOrigins = [], fetchImpl = fetch, quoteCacheDir } = {}) {
  const missing = required.filter(key => !config[key]?.trim());
  if (missing.length) throw new Error(`Falta configurar ${missing.join(', ')} en .env.`);
  const token = config.NOTION_TOKEN;
  const movementsDb = config.NOTION_MOVIMIENTOS_DATABASE_ID;
  const accountsDb = config.NOTION_CUENTAS_DATABASE_ID;
  const fundsDb = config.NOTION_FONDOS_DATABASE_ID?.trim() || defaultFundsDb;
  const paymentsDb = config.NOTION_PAGOS_DATABASE_ID?.trim() || defaultPaymentsDb;
  const operationsDb = config.NOTION_OPERACIONES_DATABASE_ID?.trim() || defaultOperationsDb;
  const shutdown = new AbortController();
  const notion = createNotionClient({ token, fetchImpl, shutdownSignal: shutdown.signal });
  const payments = createPayments({ notion, paymentsDb, movementsDb, accountsDb });
  const investments = createFundOperations({ notion, fundsDb, operationsDb });
  const lookupQuote = createQuoteLookup({ fetchImpl, signal: shutdown.signal, cacheDirectory: quoteCacheDir });
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = `127.0.0.1:${req.socket.localPort}`;
    const origin = `http://${host}`;
    // Host bloquea DNS rebinding; Fetch Metadata cubre navegadores sin Origin.
    if (req.headers.host !== host ||
        (req.headers.origin !== undefined && req.headers.origin !== origin && !allowedOrigins.includes(req.headers.origin)) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ status: 'error', message: 'Origen de la petición no autorizado.' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'");
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '32kb' }));

  function normalizeMovement(page) {
    const p = page.properties || {};
    return {
      url: page.url,
      Name: plain(property(p, ['Name', 'Nombre', 'Concepto'])),
      Movimiento: plain(property(p, ['Movimiento'])),
      Tipo: plain(property(p, ['Tipo', 'Categoría', 'Categoria'])),
      Valor: numeric(property(p, ['Valor', 'Importe'])),
      'date:Date:start': property(p, ['Date', 'Fecha'])?.date?.start || ''
    };
  }
  function normalizeAccount(page) {
    const p = page.properties || {};
    return {
      id: page.id,
      nombre: plain(property(p, ['Name', 'Nombre', 'Cuenta'])),
      saldo: numeric(property(p, ['Saldo actual', 'Saldo Actual', 'Saldo'])),
      capital: numeric(property(p, ['Saldo con aportaciones', 'Saldo inicial'])),
      moneda: 'EUR'
    };
  }
  function apiError(res, err) {
    if (err instanceof WorkflowError) return res.status(err.status).json({ status: 'error', message: err.message });
    const message = err.name === 'TimeoutError' ? 'Notion no ha respondido en 30 segundos.' :
      err.message?.startsWith('Notion (HTTP') || err.message?.startsWith('Se ha superado') ? err.message : 'No se pudo consultar Notion. Comprueba la conexión a Internet.';
    res.status(500).json({ status: 'error', message });
  }
  function route(endpoint, work) {
    app.post(endpoint, async (req, res) => {
      try {
        const structuredContent = await work(req.body ?? {});
        res.json({ status: 'success', result: { structuredContent } });
      } catch (err) { apiError(res, err); }
    });
  }
  app.post('/api/movimientos', async (_req, res) => {
    try {
      const pages = await notion.query(movementsDb);
      const results = pages.map(normalizeMovement).filter(r => r.Movimiento && Number.isFinite(r.Valor));
      res.json({ status: 'success', result: { structuredContent: { results, has_more: false } } });
    } catch (err) { apiError(res, err); }
  });
  app.post('/api/cuentas', async (_req, res) => {
    try {
      const accounts = (await notion.query(accountsDb)).map(normalizeAccount);
      const investor = accounts.find(account => isMyInvestor(account.nombre));
      const capital = investor?.capital;
      const capitalInvertido = Number.isFinite(capital) && capital >= 0 ? capital : null;
      const cuentas = accounts.filter(account => Number.isFinite(account.saldo) && !isMyInvestor(account.nombre))
        .map(({ id, nombre, saldo, moneda }) => ({ id, nombre, saldo, moneda }));
      res.json({ status: 'success', result: { structuredContent: { cuentas, capitalInvertido } } });
    } catch (err) { apiError(res, err); }
  });
  route('/api/fondos', async () => {
      const funds = await investments.positions();
      const quotes = new Map();
      const keys = [...new Set(funds.filter(fund => isinValido.test(fund.isin) && divisaValida.test(fund.divisa))
        .map(fund => `${fund.isin}:${fund.divisa}`))];
      for (let start = 0; start < keys.length && !shutdown.signal.aborted; start += 6) {
        await Promise.all(keys.slice(start, start + 6).map(async key => {
          quotes.set(key, await lookupQuote(...key.split(':')));
        }));
      }
      return valuePositions(funds, quotes);
  });
  route('/api/fondos/operaciones', investments.create);
  route('/api/pagos', payments.list);
  route('/api/pagos/crear', payments.create);
  route('/api/pagos/editar', payments.edit);
  route('/api/pagos/eliminar', payments.archive);
  route('/api/pagos/pagar', payments.pay);
  route('/api/pagos/candidatos', payments.candidates);
  route('/api/pagos/vincular', payments.link);
  app.use('/api', (_req, res) => res.status(404).json({ status: 'error', message: 'Ruta de API no encontrada.' }));
  app.use(express.static(path.resolve(root, '../dist')));
  app.get('*', (_req, res) => res.sendFile(path.resolve(root, '../dist/index.html')));
  app.use((_err, _req, res, _next) => res.status(500).json({ status: 'error', message: 'No se pudo procesar la petición local.' }));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1');
    listener.once('error', reject);
    listener.once('listening', () => { listener.removeListener('error', reject); resolve(listener); });
  });
  let closing;
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close() {
      closing ??= new Promise((resolve, reject) => {
        shutdown.abort();
        server.close(err => err ? reject(err) : resolve());
        server.closeAllConnections();
      });
      return closing;
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const local = await startServer({
      port: Number(process.env.PORT || 3001),
      quoteCacheDir: path.join(process.env.LOCALAPPDATA || homedir(), 'Gestor Financiero', 'valoraciones'),
      allowedOrigins: process.argv.includes('--dev') ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : []
    });
    console.log(`Servidor disponible en ${local.url}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      void local.close().then(() => { process.exitCode = 0; });
    });
  } catch (err) {
    console.error(err.code ? `No se pudo iniciar el servidor (${err.code}). Comprueba el puerto y los permisos.` : err.message);
    process.exitCode = 1;
  }
}
