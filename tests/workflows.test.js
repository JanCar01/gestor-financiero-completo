import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { occurrenceDate } from '../server/payments.js';
import { dateProperty, relation, richText, title } from '../server/notion.js';

const config = { NOTION_TOKEN: 'token-ficticio', NOTION_MOVIMIENTOS_DATABASE_ID: 'movements', NOTION_CUENTAS_DATABASE_ID: 'accounts',
  NOTION_PAGOS_DATABASE_ID: 'payments', NOTION_FONDOS_DATABASE_ID: 'funds', NOTION_OPERACIONES_DATABASE_ID: 'operations' };
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const amount = number => ({ number });
const select = name => ({ select: { name } });
const queryResult = results => Response.json({ results, has_more: false });

function propertyValue(properties, filter) {
  const key = Object.keys(filter).find(key => key !== 'property');
  const value = properties[filter.property]?.[key];
  switch (key) {
    case 'title': case 'rich_text': return value?.map(t => t.text?.content).join('') ?? '';
    case 'select': return value?.name ?? '';
    case 'date': return value?.start ?? '';
    case 'relation': return value?.map(entry => entry.id) ?? [];
    default: throw new Error(`Filtro de prueba sin implementar: ${key}`);
  }
}

function matches(properties, filter) {
  if (!filter) return true;
  if (filter.and) return filter.and.every(entry => matches(properties, entry));
  if (filter.or) return filter.or.some(entry => matches(properties, entry));
  const value = propertyValue(properties, filter);
  const condition = Object.entries(filter).find(([key]) => key !== 'property')[1];
  if ('equals' in condition) return value === condition.equals;
  if ('contains' in condition) return value.includes(condition.contains);
  if ('is_empty' in condition) return value.length === 0;
  if ('on_or_before' in condition) return Boolean(value) && value <= condition.on_or_before;
  if ('on_or_after' in condition) return value >= condition.on_or_after;
  throw new Error('Operador sin implementar');
}

async function setup(t) {
  const records = new Map();
  const writes = [];
  const hidden = new Set();
  let next = 100;
  let failure;
  const normalize = properties => Object.fromEntries(Object.entries(properties).map(([name, value]) =>
    [name, { type: Object.keys(value)[0], ...value }]));
  function add(db, properties, pageId = id(next++)) {
    const page = { id: pageId, parent: { database_id: db }, created_time: `2026-01-01T00:00:${String(next % 60).padStart(2, '0')}.000Z`, properties: normalize(properties) };
    records.set(pageId, page);
    return page;
  }
  const accountId = add('accounts', { Cuenta: title('Banco'), Saldo: amount(1000) }, id(1)).id;
  const alternateAccount = add('accounts', { Cuenta: title('Otra cuenta'), Saldo: amount(2000) }, id(2)).id;
  const reserve = (concept, date, interval = 1) => add('payments', { Concepto: title(concept), 'Importe previsto': amount(40),
    'Primera fecha': dateProperty(date), 'Intervalo en meses': amount(interval), 'Categoría': richText('Alquiler'), 'Cuenta habitual': relation(accountId) }).id;
  const expense = (name, date, cost, type = 'Gasto') => add('movements', { Name: title(name), Date: dateProperty(date), Valor: amount(cost),
    Movimiento: select(type), Tipo: select('Coche'), 'Cuenta bancaria': relation(alternateAccount) });
  const fund = (isin, shares, cost) => add('funds', { Fondo: title(isin), ISIN: richText(isin), Divisa: select('EUR'),
    Participaciones: amount(shares), ...(cost === undefined ? {} : { 'Coste de adquisición': amount(cost) }) }).id;
  const nav = { IE00BYX5NX33: '13,9483', IE0007987708: '41,4152', IE0031786142: '272,7152' };
  const server = await startServer({ config, fetchImpl: async (address, options) => {
    const url = new URL(address);
    if (url.hostname === 'www.quefondos.com') {
      const price = nav[url.searchParams.get('isin')];
      if (!price) return new Response(null, { status: 503 });
      return new Response(`<h4>Otro bloque</h4><section><h4>Última valoración</h4>
        <p><span class="floatleft">Fecha:</span><span class="floatright">25/11/2026</span></p>
        <p><span class="floatleft">Valor liquidativo:</span><span class="floatright">${price} EUR</span></p></section>`);
    }
    if (url.hostname !== 'api.notion.com') return new Response(null, { status: 503 });
    assert.equal(options.headers['Notion-Version'], '2022-06-28');
    const [, , table, key, command] = url.pathname.split('/');
    const body = options.body && JSON.parse(options.body);
    const method = options.method;
    if (table === 'databases' && command === 'query') {
      if (key === 'accounts') {
        const expenses = [...records.values()].filter(row => row.parent.database_id === 'movements' && row.properties.Movimiento?.select?.name === 'Gasto');
        return queryResult([...records.values()].filter(row => row.parent.database_id === 'accounts').map(row => ({ ...row, properties: {
          ...row.properties, Saldo: { type: 'number', number: row.properties.Saldo.number - expenses.filter(expense =>
            expense.properties['Cuenta bancaria']?.relation?.[0]?.id === row.id).reduce((sum, expense) => sum + expense.properties.Valor.number, 0) }
        } })));
      }
      return queryResult([...records.values()].filter(row => !hidden.has(row.id) && !row.archived && row.parent.database_id === key && matches(row.properties, body.filter)));
    }
    if (table === 'databases' && method === 'GET') return Response.json({ properties: { Tipo: { select: { options: ['Alquiler', 'Coche'].map(name => ({ name })) } } } });
    if (table === 'pages' && method === 'GET') return records.has(key)
      ? Response.json(records.get(key)) : Response.json({}, { status: 404 });
    assert.equal(table, 'pages');
    const mode = failure;
    failure = null;
    writes.push({ method, key, body });
    if (mode === 'denied') return Response.json({ message: 'interno token-ficticio' }, { status: 403 });
    const result = method === 'POST' ? add(body.parent.database_id, body.properties) : records.get(key);
    if (method === 'PATCH' && body.properties) Object.assign(result.properties, normalize(body.properties));
    if (method === 'PATCH' && body.archived) result.archived = true;
    if (mode === 'delayed' || mode === 'unindexed') hidden.add(result.id);
    if (mode === 'delayed' || mode === 'committed') throw new DOMException('Timeout simulado', 'TimeoutError');
    return Response.json(result);
  } });
  t.after(() => server.close());
  const post = async (route, body = {}, headers = {}) => {
    const response = await fetch(`${server.url}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const json = await response.json();
    return { status: response.status, data: json.result?.structuredContent, message: json.message };
  };
  return { post, accountId, alternateAccount, reserve, expense, fund, writes, records, failNext: mode => { failure = mode; }, reveal: () => hidden.clear() };
}

test('ocurrencias únicas, mensuales y semestrales conservan el día de ancla', () => {
  assert.equal(occurrenceDate('2027-01-31', 1, '2027-02'), '2027-02-28');
  assert.equal(occurrenceDate('2027-01-31', 1, '2027-03'), '2027-03-31');
  assert.equal(occurrenceDate('2027-12-31', 1, '2028-01'), '2028-01-31');
  assert.equal(occurrenceDate('2027-12-31', 1, '2028-02'), '2028-02-29');
  assert.equal(occurrenceDate('2027-08-31', 6, '2028-02'), '2028-02-29');
  assert.equal(occurrenceDate('2027-08-31', 6, '2028-01'), null);
  assert.equal(occurrenceDate('2027-08-31', 6, '2027-08'), '2027-08-31');
  assert.equal(occurrenceDate('2027-08-31', 6, '2027-02'), null);
  assert.equal(occurrenceDate('2027-08-31', 0, '2027-08'), '2027-08-31');
  assert.equal(occurrenceDate('2027-08-31', 0, '2028-02'), null);
});

test('crear y pagar en otro mes registra un solo gasto asociado a la cuenta real', async t => {
  const { post, accountId, alternateAccount, writes, failNext, reveal } = await setup(t);
  const draft = { requestId: id(50), concept: 'Alquiler', amount: 110, firstDate: '2027-01-31', interval: 1, category: 'Alquiler', accountId };
  assert.equal((await post('pagos/crear', draft, { Origin: 'https://example.org' })).status, 403);
  const [definition, repeated] = await Promise.all([post('pagos/crear', draft), post('pagos/crear', draft)]);
  assert.equal(definition.status, 200);
  assert.equal(definition.data.id, repeated.data.id);
  assert.equal(writes.length, 1);
  const before = (await post('pagos', { mes: '2027-01' })).data;
  assert.equal(before.pending, 110);
  assert.deepEqual(before.categories, ['Alquiler', 'Coche']);
  const confirmation = { id: definition.data.id, fechaPrevista: '2027-01-31', date: '2027-02-01', amount: 111.50, accountId: alternateAccount };
  failNext('unindexed');
  const [paid, retry] = await Promise.all([post('pagos/pagar', confirmation), post('pagos/pagar', confirmation)]);
  assert.equal(paid.status, 200);
  assert.equal(paid.data.id, retry.data.id);
  assert.equal(writes.length, 2);
  const { parent, properties } = writes[1].body;
  assert.deepEqual(parent, { database_id: 'movements' });
  assert.deepEqual(properties['Cuenta bancaria'], relation(alternateAccount));
  assert.deepEqual(properties['Fecha prevista'], dateProperty('2027-01-31'));
  assert.deepEqual(properties['Clave de ocurrencia'], richText(`${definition.data.id}:2027-01-31`));
  assert.deepEqual(properties.Movimiento, select('Gasto'));
  const january = (await post('pagos', { mes: '2027-01' })).data;
  assert.equal(january.pending, 0);
  assert.equal(january.occurrences[0].paid.amount, 111.50);
  reveal();
  assert.equal((await post('movimientos')).data.results[0]['date:Date:start'], '2027-02-01');
  assert.equal((await post('cuentas')).data.cuentas.find(account => account.id === alternateAccount).saldo, 1888.50);
  const february = (await post('pagos', { mes: '2027-02' })).data;
  assert.equal(february.pending, 110);
  assert.equal(february.occurrences[0].date, '2027-02-28');
  assert.equal(february.occurrences[0].paid, null);
});

test('vincular un gasto del Atajo solo actualiza el seguimiento y evita vínculos dobles', async t => {
  const { post, reserve, expense, writes } = await setup(t);
  const scheduled = reserve('Seguro', '2026-11-30');
  const other = reserve('Cuota', '2026-11-30');
  const existing = expense('Atajo', '2026-12-01', 42);
  const original = structuredClone(existing.properties);
  const income = expense('Ingreso', '2026-11-30', 40, 'Ingreso');
  const farther = expense('Otro gasto', '2026-12-25', 40);
  const key = { id: scheduled, fechaPrevista: '2026-11-30' };
  assert.deepEqual((await post('pagos/candidatos', key)).data.candidates.map(row => row.id), [existing.id, farther.id]);
  assert.equal((await post('pagos/vincular', { ...key, expenseId: income.id })).status, 400);
  const linked = await post('pagos/vincular', { ...key, expenseId: existing.id });
  assert.equal(linked.status, 200);
  assert.equal((await post('pagos/vincular', { ...key, expenseId: existing.id })).data.id, existing.id);
  assert.equal((await post('pagos/vincular', { ...key, id: other, expenseId: existing.id })).status, 409);
  assert.equal((await post('pagos/vincular', { ...key, expenseId: farther.id })).status, 409);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
  assert.deepEqual(Object.keys(writes[0].body.properties).sort(), ['Clave de ocurrencia', 'Fecha prevista', 'Pago previsto']);
  for (const [name, property] of Object.entries(original)) assert.deepEqual(existing.properties[name], property);
  const list = (await post('pagos', { mes: '2026-11' })).data;
  assert.equal(list.occurrences.find(row => row.id === scheduled).paid.id, existing.id);
});

test('gestiona permisos de Notion y reconcilia un POST incierto antes de reintentar', async t => {
  const { post, reserve, accountId, failNext, reveal, writes } = await setup(t);
  const draft = { id: reserve('Luz', '2026-11-11'), fechaPrevista: '2026-11-11', date: '2026-11-12', amount: 30, accountId };
  failNext('denied');
  const denied = await post('pagos/pagar', draft);
  assert.equal(denied.status, 500);
  assert.match(denied.message, /HTTP 403.*permisos/);
  assert.doesNotMatch(denied.message, /token-ficticio/);
  failNext('delayed');
  assert.equal((await post('pagos/pagar', draft)).status, 503);
  assert.equal((await post('pagos/pagar', draft)).status, 503);
  assert.equal(writes.length, 2);
  reveal();
  assert.equal((await post('pagos/pagar', draft)).status, 200);
  assert.equal(writes.length, 2);
});

test('editar y eliminar una previsión conserva el gasto y su mes previsto', async t => {
  const { post, reserve, accountId, alternateAccount, records, writes, failNext } = await setup(t);
  const payment = reserve('Seguro', '2027-01-15');
  const original = { id: payment, fechaPrevista: '2027-01-15', date: '2027-01-16', accountId, amount: 40 };
  const paid = await post('pagos/pagar', original);
  assert.equal(paid.status, 200);
  const snapshot = structuredClone(records.get(paid.data.id));
  const edit = { id: payment, concept: 'Seguro nuevo', amount: 55, firstDate: '2027-01-25', interval: 2,
    category: 'Coche', accountId: alternateAccount };
  assert.equal((await post('pagos/editar', { ...edit, amount: 0 })).status, 400);
  assert.equal((await post('pagos/editar', { ...edit, id: paid.data.id })).status, 404);
  failNext('committed');
  assert.equal((await post('pagos/editar', edit)).status, 200);
  assert.equal((await post('pagos/editar', edit)).status, 200);
  const january = (await post('pagos', { mes: '2027-01' })).data;
  assert.equal(january.pending, 0);
  assert.equal(january.occurrences.length, 1);
  assert.equal(january.occurrences[0].date, original.fechaPrevista);
  assert.equal(january.occurrences[0].paid.amount, original.amount);
  assert.equal(january.occurrences[0].definition.accountId, alternateAccount);
  assert.equal((await post('pagos/pagar', { ...original, fechaPrevista: '2027-01-25' })).status, 409);
  assert.equal((await post('pagos', { mes: '2027-02' })).data.occurrences.length, 0);
  const march = (await post('pagos', { mes: '2027-03' })).data;
  assert.equal(march.pending, 55);
  assert.equal(march.occurrences[0].date, '2027-03-25');
  assert.equal((await post('pagos/eliminar', { id: paid.data.id })).status, 404);
  failNext('committed');
  assert.equal((await post('pagos/eliminar', { id: payment })).status, 200);
  assert.equal((await post('pagos/eliminar', { id: payment })).status, 200);
  assert.equal((await post('pagos/editar', edit)).status, 404);
  assert.equal((await post('pagos', { mes: '2027-03' })).data.occurrences.length, 0);
  const historical = (await post('pagos', { mes: '2027-01' })).data.occurrences[0];
  assert.equal(historical.definition, null);
  assert.equal(historical.paid.id, paid.data.id);
  assert.deepEqual(records.get(paid.data.id), snapshot);
  assert.deepEqual(writes.map(write => write.method), ['POST', 'PATCH', 'PATCH']);
  assert.deepEqual(writes[2].body, { archived: true });
});

test('valora la cartera con el coste de apertura y marca totales parciales', async t => {
  const { post, fund } = await setup(t);
  t.mock.method(console, 'warn', () => {});
  fund('IE00BYX5NX33', 65.038, 908.71);
  fund('IE0007987708', 8.59, 359.17);
  fund('IE0031786142', 0.63, 192.20);
  const { resumen } = (await post('fondos')).data;
  assert.deepEqual([resumen.costeRestante, resumen.valor, resumen.ganancia, resumen.rentabilidad].map(value => value.toFixed(2)),
    ['1460.08', '1434.74', '-25.34', '-1.74']);
  fund('IE0000000001', 2, 10);
  const partial = (await post('fondos')).data.resumen;
  assert.equal(partial.parcial, true);
  assert.equal(partial.costeRestante, 1470.08);
  assert.equal(partial.ganancia, null);
  assert.equal(partial.rentabilidad, null);
});

test('compras y ventas se registran una vez, con coste medio y validación retroactiva', async t => {
  const { post, fund, records, writes, failNext } = await setup(t);
  const fundId = fund('IE00BYX5NX33', 10, 100);
  const buy = { key: id(30), fundId, type: 'Compra', date: '2020-10-05', shares: 5, amount: 75 };
  failNext('committed');
  const bought = await post('fondos/operaciones', buy);
  assert.equal(bought.status, 200);
  assert.deepEqual([bought.data.participaciones, bought.data.costeRestante], [15, 175]);
  const sell = { key: id(31), fundId, type: 'Venta', date: '2020-10-06', shares: 6, amount: 90 };
  failNext('unindexed');
  const [sold, retried] = await Promise.all([post('fondos/operaciones', sell), post('fondos/operaciones', sell)]);
  assert.equal(sold.status, 200);
  assert.equal(sold.data.operacion.id, retried.data.operacion.id);
  assert.deepEqual([sold.data.participaciones, sold.data.costeRestante], [9, 105]);
  assert.equal(writes[1].body.properties.Importe.number, 90);
  assert.equal((await post('fondos/operaciones', { ...sell, key: id(32), date: '2020-10-04', shares: 10 })).status, 409);
  assert.equal((await post('fondos/operaciones', { ...sell, key: id(33), date: '2099-01-01' })).status, 400);
  const closed = await post('fondos/operaciones', { ...sell, key: id(34), date: '2020-10-07', shares: 9 });
  assert.equal(closed.status, 200);
  assert.deepEqual([closed.data.participaciones, closed.data.costeRestante], [0, 0]);
  assert.deepEqual(writes.map(write => write.body.parent.database_id), ['operations', 'operations', 'operations']);
  assert.equal(records.get(fundId).properties.Participaciones.number, 10);
  assert.equal(records.get(fundId).properties['Coste de adquisición'].number, 100);
  assert.equal((await post('movimientos')).data.results.length, 0);
});
