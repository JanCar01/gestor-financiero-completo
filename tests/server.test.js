import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { startServer, loadConfiguration } from '../server/index.js';

const config = {
  NOTION_TOKEN: 'test-secret-do-not-expose',
  NOTION_MOVIMIENTOS_DATABASE_ID: 'movements',
  NOTION_CUENTAS_DATABASE_ID: 'accounts'
};
const title = text => ({ type: 'title', title: [{ plain_text: text }] });
const select = name => ({ type: 'select', select: { name } });
const page = (name, movement, category, amount) => ({
  url: 'https://www.notion.so/test', properties: {
    Nombre: title(name), Movimiento: select(movement), Categoría: select(category),
    Importe: { type: 'number', number: amount }, Fecha: { date: { start: '2026-11-03' } }
  }
});

test('validación temprana de las tres variables sin mostrar valores', async () => {
  await assert.rejects(startServer({ config: {} }), /NOTION_TOKEN.*NOTION_MOVIMIENTOS_DATABASE_ID.*NOTION_CUENTAS_DATABASE_ID/);
});

test('el .env externo se carga y prevalece sobre las variables del entorno', () => {
  const parent = path.resolve('.verify');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'config-'));
  const envPath = path.join(directory, '.env');
  const previous = process.env.NOTION_TOKEN;
  try {
    process.env.NOTION_TOKEN = 'environment-test';
    writeFileSync(envPath, 'NOTION_TOKEN="external-test"\nNOTION_MOVIMIENTOS_DATABASE_ID=movements\nNOTION_CUENTAS_DATABASE_ID=accounts\n');
    assert.equal(loadConfiguration(envPath).NOTION_TOKEN, 'external-test');
    assert.equal(process.env.NOTION_TOKEN, 'environment-test');
  } finally {
    if (previous === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = previous;
    rmSync(envPath);
    rmdirSync(directory);
  }
});

test('puerto dinámico, interfaz, paginación, normalización, seguridad y cierre', async t => {
  const calls = [];
  const local = await startServer({ config, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const body = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, `Bearer ${config.NOTION_TOKEN}`);
    assert.equal(body.page_size, 100);
    if (url.includes('/movements/')) {
      return Response.json(body.start_cursor ? { results: [page('Traspaso', 'Transferencia', '', 20), page('Inversión', 'Gasto', 'Inversion', 30)], has_more: false } :
        { results: [page('Compra', 'Gasto', 'Comida', 10), page('Nómina', 'Ingreso', 'Sueldo', 2000)], has_more: true, next_cursor: 'next' });
    }
    return Response.json({ results: [
      { id: 'bank', properties: { Cuenta: title('Banco'), Saldo: { type: 'formula', formula: { number: 100 } } } },
      { id: 'portfolio', properties: {
        Name: title('MyInvestor'), Saldo: { type: 'number', number: 9000 },
        'Saldo inicial': { type: 'number', number: 1220.38 }, 'Saldo con aportaciones': { type: 'formula', formula: { number: 1460.38 } }
      } }
    ], has_more: false });
  } });
  t.after(() => local.close());
  assert.equal(local.server.address().address, '127.0.0.1');
  assert.ok(local.server.address().port > 0);
  const html = await fetch(local.url);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<html/);
  assert.match(html.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(html.headers.get('access-control-allow-origin'), null);
  const response = await fetch(`${local.url}/api/movimientos`, { method: 'POST', headers: { Origin: local.url } });
  assert.equal(response.status, 200);
  const data = await response.json();
  const rows = data.result.structuredContent.results;
  assert.deepEqual(rows.map(r => [r.Movimiento, r.Tipo, r.Valor]), [['Gasto','Comida',10], ['Ingreso','Sueldo',2000], ['Transferencia','',20], ['Gasto','Inversion',30]]);
  assert.equal(rows[0]['date:Date:start'], '2026-11-03');
  assert.equal(JSON.parse(calls[1].options.body).start_cursor, 'next');
  assert.ok(!JSON.stringify(data).includes(config.NOTION_TOKEN));
  // Las herramientas locales sin Origin siguen funcionando.
  const accounts = await fetch(`${local.url}/api/cuentas`, { method: 'POST' });
  assert.deepEqual((await accounts.json()).result.structuredContent, {
    cuentas: [{ id: 'bank', nombre: 'Banco', saldo: 100, moneda: 'EUR' }], capitalInvertido: 1460.38
  });
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await fetch(`${local.url}/api/cuentas`, { method: 'POST', headers })).status, 403);
  }
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.request(`${local.url}/api/cuentas`, { method: 'POST', headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal(calls.length, 3);
  assert.equal((await fetch(`${local.url}/api/unknown`)).status, 404);
  await local.close();
  await local.close();
  await assert.rejects(fetch(local.url));
});

test('valoración por ISIN, precisión y posiciones incompletas', async t => {
  const fund = (id, isin, shares, currency = 'EUR') => ({ id, properties: {
    Fondo: title(id), ISIN: { type: 'rich_text', rich_text: [{ plain_text: isin }] },
    Participaciones: { type: 'number', number: shares }, Divisa: select(currency)
  } });
  const fields = (label, value) => `<p><span class="floatleft">${label}:</span><span class="floatright">${value}</span></p>`;
  const quote = (nav, date, direction) => new Response(`<div><h4>&Uacute;ltima valoraci&oacute;n</h4><div>
    ${fields('Valor liquidativo', nav)}${fields('Fecha', date)}${fields('1 d&iacute;a', `<b>${direction}</b>`)}</div></div>
    <div>${fields('1 día', '+100,00%')}</div>`);
  const calls = [];
  const warnings = t.mock.method(console, 'warn', () => {});
  const local = await startServer({ config, fetchImpl: async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'api.notion.com') {
      if (target.pathname.includes('/424e79e9-3d2d-8185-ac18-c2dda933273b/')) return Response.json({ results: [], has_more: false });
      assert.equal(target.pathname, '/v1/databases/424e79e9-3d2d-81f4-8dc2-f6a6ecca9248/query');
      return Response.json({ has_more: false, results: [
        fund('value', ' ie00byx5nx33 ', 1.23456), fund('pending', 'IE00BYX5NX33', null), fund('zero', 'IE00BYX5NX33', 0),
        fund('wrong-currency', 'IE0007987708', 1), fund('bad-date', 'IE0031786142', 1),
        fund('bad-isin', '&other=1', 1), fund('unavailable', 'LU0123456789', 1), fund('no-daily', 'LU0123456780', 1)
      ] });
    }
    if (['www.es.vanguard', 'www.finect.com'].includes(target.hostname)) return new Response(null, { status: 503 });
    assert.equal(target.hostname, 'www.quefondos.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers, undefined);
    const isin = target.searchParams.get('isin');
    calls.push(isin);
    if (isin === 'IE00BYX5NX33') return quote('1.234,567890&nbsp;EUR', '24/11/2026', '−0,84%');
    if (isin === 'IE0007987708') return quote('41,835700 USD', '24/11/2026', '+0,62%');
    if (isin === 'IE0031786142') return quote('280,332000 EUR', '31/11/2026', '2,84%');
    if (isin === 'LU0123456780') return quote('123,45 EUR', '24/11/2026', '—');
    return new Response('Service unavailable', { status: 503 });
  } });
  t.after(() => local.close());
  const response = await fetch(`${local.url}/api/fondos`, { method: 'POST' });
  assert.equal(response.status, 200);
  const { fondos } = (await response.json()).result.structuredContent;
  const [value, pending, zero, wrongCurrency, badDate, badIsin, unavailable, noDaily] = fondos;
  assert.equal(value.isin, 'IE00BYX5NX33');
  assert.deepEqual(value.valoracion, {
    isin: 'IE00BYX5NX33', valorLiquidativo: 1234.56789, divisa: 'EUR', fechaValoracion: '2026-11-24', fuente: 'Quefondos', variacionDiaria: -0.84
  });
  assert.match(warnings.mock.calls.map(call => call.arguments[0]).join('\n'), /Finect \(IE00BYX5NX33\): HTTP 503/);
  assert.ok(!Object.hasOwn(value, 'avisoInvesting'));
  assert.equal(value.valor, 1524.1481342784);
  assert.equal(pending.valor, null);
  assert.deepEqual(pending.valoracion, value.valoracion);
  assert.equal(zero.valor, 0);
  for (const fund of [wrongCurrency, badDate, badIsin, unavailable]) {
    assert.equal(fund.valoracion, null);
    assert.equal(fund.valor, null);
  }
  assert.equal(noDaily.valor, 123.45);
  assert.equal(noDaily.valoracion.variacionDiaria, null);
  assert.deepEqual(calls.sort(), ['IE0007987708', 'IE0031786142', 'IE00BYX5NX33', 'LU0123456780', 'LU0123456789']);
});

test('selecciona la valoración más reciente de Vanguard o Finect y conserva el último dato válido', async t => {
  const funds = [
    ['IE00BYX5NX33', 'IE00BYX5NX33-Fidelity_msci_world_index_eur_p_acc', 13.9686, 13.9483, 'Finect'],
    ['IE0007987708', 'vanguard-european-stock-index-fund-eur-acc', 41.8357, 41.4152, 'Vanguard España'],
    ['IE0031786142', 'emerging-markets-stock-index-fund-eur', 280.332, 272.7152, 'Vanguard España']
  ];
  const shares = 2.3456;
  mkdirSync('.verify', { recursive: true });
  const quoteCacheDir = mkdtempSync(path.resolve('.verify', 'quotes-'));
  const html = body => new Response(body, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
  const price = value => String(value).replace('.', ',');
  const warnings = t.mock.method(console, 'warn', () => {});
  let phase;
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'api.notion.com' && target.pathname.includes('/424e79e9-3d2d-8185-ac18-c2dda933273b/')) {
      return Response.json({ results: [], has_more: false });
    }
    if (target.hostname === 'api.notion.com') return Response.json({ has_more: false, results: funds.map(([isin]) => ({
      id: isin, properties: { Fondo: title(isin), ISIN: { type: 'rich_text', rich_text: [{ plain_text: isin }] },
        Participaciones: { type: 'number', number: shares }, Divisa: select('EUR') }
    })) });
    if (target.hostname === 'www.quefondos.com') {
      if (['alternative-only', 'offline', 'wrong-metadata'].includes(phase)) return new Response(null, { status: 503 });
      const item = funds.find(([isin]) => isin === target.searchParams.get('isin'));
      const day = phase === 'quefondos-newer' ? '26' : phase === 'same-date' ? '25' : '24';
      return html(`<div><h4>Última valoración</h4>
        <p><span class="floatleft">Valor liquidativo:</span><span class="floatright">${price(item[2])} EUR</span></p>
        <p><span class="floatleft">Fecha:</span><span class="floatright">${day}/11/2026</span></p>
        <p><span class="floatleft">1 día:</span><span class="floatright">+0,42%</span></p></div>`);
    }
    const item = funds.find(([, slug]) => target.pathname.endsWith(`/${slug}`));
    assert.ok(item);
    const [isin, , , nav, source] = item;
    assert.equal(target.hostname, source === 'Finect' ? 'www.finect.com' : 'www.es.vanguard');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, undefined);
    if (phase === 'offline' || phase === 'alternative-unavailable') return new Response(null, { status: 503 });
    const correctIsin = phase === 'wrong-metadata' && isin === 'IE0007987708' ? 'IE00BYX5NX33' : isin;
    const currency = phase === 'wrong-metadata' && isin !== 'IE0007987708' ? 'USD' : 'EUR';
    if (source === 'Finect') {
      const model = { isin, currency: { code: currency },
        lastQuote: { datetime: '2026-11-25T00:00:00.000Z', price: nav, percentChange: -0.1453 } };
      const state = { fund: { fund: { model }, sameManagementCompanyFunds: [
        { ...model, currency: { code: 'EUR' }, lastQuote: { datetime: '2026-11-27', price: 999 } }
      ] } };
      return html(`<script>window.INITIAL_STATE=${JSON.stringify(JSON.stringify(state))};</script>`);
    }
    const previousRows = phase !== 'previous-unavailable'
      ? `<tr><th>24 nov 2026</th><td>${price(item[2])}&nbsp;€</td></tr>`
      : isin === 'IE0007987708'
        ? '<tr><th>23 nov 2026</th><td>42,0974&nbsp;€</td></tr><tr><th>24 nov 2026</th><td>—</td></tr>'
        : '';
    return html(`<meta name="isin" content="${correctIsin}"><meta name="currency" content="${currency}">
      <europe-core-historical-prices><h5>Precios históricos</h5>
      <table><thead><tr><th>Fecha</th><th>Valor de activos neto (EUR)</th></tr></thead><tbody>
        ${previousRows}
        <tr><th>25 nov 2026</th><td>${price(nav)}&nbsp;€</td></tr>
      </tbody></table></europe-core-historical-prices>`);
  };
  let local;
  const query = async () => {
    const response = await fetch(`${local.url}/api/fondos`, { method: 'POST' });
    assert.equal(response.status, 200);
    return (await response.json()).result.structuredContent.fondos;
  };
  const assertQuotes = (positions, day, useAlternative, cached) => {
    assert.equal(positions.length, 3);
    positions.forEach(({ valor, valoracion, valoracionGuardada }, index) => {
      const [isin, , quefondos, alternative, source] = funds[index];
      assert.deepEqual([valoracion.fechaValoracion, valoracion.fuente, valoracionGuardada],
        [`2026-11-${day}`, useAlternative ? source : 'Quefondos', cached]);
      const nav = useAlternative ? alternative : quefondos;
      assert.equal(valoracion.isin, isin);
      assert.equal(valoracion.divisa, 'EUR');
      assert.equal(valoracion.valorLiquidativo, nav);
      assert.ok(Math.abs(valor - shares * nav) < 1e-12);
    });
  };
  try {
    local = await startServer({ config, fetchImpl, quoteCacheDir });
    phase = 'wrong-metadata';
    const unavailable = await query();
    assert.ok(unavailable.every(fund => fund.valoracion === null && fund.valor === null && !fund.valoracionGuardada));
    assert.equal(warnings.mock.callCount(), 3);
    phase = 'alternative-newer';
    const newer = await query();
    assertQuotes(newer, '25', true, false);
    assert.equal(newer[0].valoracion.variacionDiaria, -0.1453);
    assert.equal(newer[1].valoracion.variacionDiaria.toFixed(2), '-1.01');
    assert.equal(newer[2].valoracion.variacionDiaria.toFixed(2), '-2.72');
    phase = 'previous-unavailable';
    const withoutPrevious = await query();
    assertQuotes(withoutPrevious, '25', true, false);
    assert.ok(withoutPrevious.slice(1).every(fund => fund.valoracion.variacionDiaria === null));
    phase = 'same-date';
    const tied = await query();
    assertQuotes(tied, '25', false, false);
    assert.ok(tied.every(fund => fund.valoracion.variacionDiaria === 0.42));
    phase = 'quefondos-newer';
    assertQuotes(await query(), '26', false, false);
    phase = 'alternative-only';
    const alternatives = await query();
    assertQuotes(alternatives, '25', true, false);
    assert.deepEqual(alternatives.map(fund => fund.valoracion.variacionDiaria), newer.map(fund => fund.valoracion.variacionDiaria));
    phase = 'alternative-unavailable';
    assertQuotes(await query(), '24', false, false);
    const logged = warnings.mock.calls.slice(3).map(call => call.arguments[0]);
    assert.equal(logged.length, 3);
    assert.ok(logged.every(message => message.endsWith('HTTP 503')));
    phase = 'offline';
    const saved = await query();
    assertQuotes(saved, '26', false, true);
    await local.close();
    local = await startServer({ config, fetchImpl, quoteCacheDir });
    assertQuotes(await query(), '26', false, true);
  } finally {
    await local?.close();
    for (const [isin] of funds) rmSync(path.join(quoteCacheDir, `${isin}-EUR.json`), { force: true });
    rmdirSync(quoteCacheDir);
  }
});

test('errores de Notion no reflejan secretos ni mensajes remotos', async t => {
  const local = await startServer({ config, fetchImpl: async () => Response.json({ message: config.NOTION_TOKEN }, { status: 401 }) });
  t.after(() => local.close());
  const response = await fetch(`${local.url}/api/cuentas`, { method: 'POST' });
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.match(text, /Comprueba NOTION_TOKEN/);
  assert.ok(!text.includes(config.NOTION_TOKEN));
});

test('un conflicto de puerto rechaza el arranque y permite cerrar el primer servidor', async t => {
  const local = await startServer({ config });
  t.after(() => local.close());
  await assert.rejects(startServer({ config, port: local.server.address().port }), { code: 'EADDRINUSE' });
});

test('cerrar el servidor cancela una consulta pendiente de Notion', async () => {
  let signal;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const local = await startServer({ config, fetchImpl: (_url, options) => {
    signal = options.signal;
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const request = fetch(`${local.url}/api/movimientos`, { method: 'POST' }).catch(() => null);
  await ready;
  await local.close();
  assert.equal(signal.aborted, true);
  assert.equal(local.server.listening, false);
  await request;
});
