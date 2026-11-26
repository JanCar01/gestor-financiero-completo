import Decimal from 'decimal.js';
import { dateProperty, numeric, plain, relation, richText, title } from './notion.js';
import { canonicalId, createSerializer, createWriteGuard, dateOnly, inDatabase, madridToday, positive, WorkflowError } from './workflow.js';

const Amount = Decimal.clone({ precision: 40 });
const opening = value => Number.isFinite(value) && value >= 0 ? new Amount(value) : null;
const operationTypes = ['Compra', 'Venta'];

function fund(page) {
  const p = page.properties || {};
  return { id: page.id, nombre: plain(p.Fondo).trim() || 'Fondo sin nombre', isin: plain(p.ISIN).trim().toUpperCase(),
    divisa: plain(p.Divisa).trim().toUpperCase(), shares: opening(numeric(p.Participaciones)),
    cost: opening(numeric(p['Coste de adquisición'])) };
}

function operation(page) {
  const p = page.properties || {};
  return { id: page.id, created: page.created_time || '', key: plain(p['Clave de operación']), type: plain(p.Tipo),
    fundIds: (p.Fondo?.relation ?? []).map(item => canonicalId(item.id)), date: dateOnly(p.Fecha?.date?.start),
    shares: numeric(p.Participaciones), amount: numeric(p.Importe) };
}

function replay(position, entries) {
  let { shares, cost } = position;
  const ordered = [...entries].sort((a, b) => (a.date || '').localeCompare(b.date || '') ||
    a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  for (const entry of ordered) {
    if (!entry.date || !operationTypes.includes(entry.type) || entry.fundIds.length !== 1 || !positive(entry.shares) || !positive(entry.amount)) {
      throw new WorkflowError(409, 'El historial contiene una operación con datos incompletos o inválidos.');
    }
    if (shares === null) throw new WorkflowError(409, 'Completa las participaciones de apertura del fondo.');
    if (entry.type === 'Compra') {
      shares = shares.plus(entry.shares);
      cost = cost?.plus(entry.amount) ?? null;
      continue;
    }
    if (shares.lt(entry.shares)) throw new WorkflowError(409, `La venta del ${entry.date.split('-').reverse().join('/')} supera las participaciones disponibles.`);
    const remaining = shares.minus(entry.shares);
    cost = remaining.isZero() ? new Amount(0) : cost?.times(remaining).div(shares) ?? null;
    shares = remaining;
  }
  return { shares, cost };
}

export function valuePositions(positions, quotes) {
  let value = new Amount(0), cost = new Amount(0);
  let valued = 0, expected = 0, knownCost = true;
  const fondos = positions.map(({ shares, cost: basis, ...fund }) => {
    const { valoracion = null, valoracionGuardada = false } = quotes.get(`${fund.isin}:${fund.divisa}`) ?? {};
    const closed = shares?.isZero();
    const market = closed ? new Amount(0) : shares && valoracion ? shares.times(valoracion.valorLiquidativo) : null;
    if (!closed) {
      expected++;
      if (market && fund.divisa === 'EUR') { valued++; value = value.plus(market); }
    }
    if (basis) cost = cost.plus(basis);
    else knownCost = false;
    const gain = market && basis && (closed || fund.divisa === 'EUR') ? market.minus(basis) : null;
    return { ...fund, participaciones: shares?.toNumber() ?? null, costeRestante: basis?.toNumber() ?? null,
      valoracion, valoracionGuardada, valor: market?.toNumber() ?? null, ganancia: gain?.toNumber() ?? null,
      rentabilidad: gain && basis.gt(0) ? gain.div(basis).times(100).toNumber() : null };
  });
  const complete = valued === expected;
  const gain = complete && knownCost ? value.minus(cost) : null;
  return { fondos, resumen: { valor: complete || valued ? value.toNumber() : null, parcial: !complete, valorados: valued, posiciones: expected,
    costeRestante: knownCost ? cost.toNumber() : null, ganancia: gain?.toNumber() ?? null,
    rentabilidad: gain && cost.gt(0) ? gain.div(cost).times(100).toNumber() : null } };
}

export function createFundOperations({ notion, fundsDb, operationsDb }) {
  const serial = createSerializer();
  const writeGuard = createWriteGuard();
  const confirmed = new Map();
  const byFund = id => ({ property: 'Fondo', relation: { contains: id } });

  function operationsIncludingConfirmed(pages) {
    const rows = new Map([...confirmed.values()].map(row => [row.id, row]));
    for (const row of pages.map(operation)) {
      if (confirmed.get(row.key)?.id === row.id) confirmed.delete(row.key);
      rows.set(row.id, row);
    }
    return [...rows.values()];
  }

  return {
    async positions() {
      const [funds, operations] = await Promise.all([notion.query(fundsDb), notion.query(operationsDb)]);
      const grouped = new Map();
      for (const entry of operationsIncludingConfirmed(operations)) for (const id of entry.fundIds) {
        if (!grouped.has(id)) grouped.set(id, []);
        grouped.get(id).push(entry);
      }
      return funds.map(page => {
        const position = fund(page);
        try { return { ...position, ...replay(position, grouped.get(canonicalId(page.id)) ?? []) }; }
        catch (error) {
          if (!(error instanceof WorkflowError)) throw error;
          return { ...position, shares: null, cost: null, problema: error.message };
        }
      });
    },
    async create(body) {
      const id = canonicalId(body.fundId);
      const key = canonicalId(body.key);
      const date = dateOnly(body.date);
      const { type, shares, amount } = body;
      if (!id || !key || !date || date > madridToday() || !operationTypes.includes(type) || !positive(shares) || !positive(amount)) {
        throw new WorkflowError(400, 'Elige un fondo, introduce importes y participaciones positivos y usa una fecha efectiva que no sea futura.');
      }
      const scopes = [`fund:${id}`, `operation:${key}`];
      return serial(scopes, async () => {
        let position, entries;
        const saved = await writeGuard(key, scopes, async () => {
          const pages = await notion.query(operationsDb, { filter: { property: 'Clave de operación', rich_text: { equals: key } } });
          const matches = operationsIncludingConfirmed(pages).filter(row => row.key === key);
          const [existing] = matches;
          if (matches.length > 1 || existing && (existing.fundIds.length !== 1 || existing.fundIds[0] !== id ||
              existing.date !== date || existing.type !== type || existing.shares !== shares || existing.amount !== amount)) {
            throw new WorkflowError(409, 'La clave ya está asociada a otra operación.');
          }
          return existing;
        }, async () => operation(await notion.create(operationsDb, { Operación: title(`${type} · ${position.nombre}`.slice(0, 2000)), Fondo: relation(id),
          Fecha: dateProperty(date), Tipo: { select: { name: type } }, Participaciones: { number: shares },
          Importe: { number: amount }, 'Clave de operación': richText(key) })), async () => {
          const [page, history] = await Promise.all([notion.page(id), notion.query(operationsDb, { filter: byFund(id) })]);
          if (!inDatabase(page, fundsDb) || page.archived || page.in_trash) throw new WorkflowError(404, 'El fondo no está disponible.');
          position = fund(page);
          entries = operationsIncludingConfirmed(history).filter(row => row.fundIds.includes(id));
          const now = new Date().toISOString();
          const provisional = { id: '\uffff', created: now, type, date, shares, amount, fundIds: [id] };
          replay(position, [...entries, provisional]);
          // Notion puede asignar la misma marca de minuto. Una venta tiene que ser viable desde el primer orden posible.
          const minute = `${now.slice(0, 16)}:00.000Z`;
          if (type === 'Venta' && entries.some(row => row.date === date && row.created === minute)) {
            replay(position, [...entries, { ...provisional, id: '', created: minute }]);
          }
        });
        confirmed.set(key, saved);
        if (!position) {
          const [page, history] = await Promise.all([notion.page(id), notion.query(operationsDb, { filter: byFund(id) })]);
          position = fund(page);
          entries = operationsIncludingConfirmed(history).filter(row => row.fundIds.includes(id) && row.id !== saved.id);
        }
        const effective = replay(position, [...entries, saved]);
        return { operacion: saved, participaciones: effective.shares?.toNumber() ?? null, costeRestante: effective.cost?.toNumber() ?? null };
      });
    }
  };
}
