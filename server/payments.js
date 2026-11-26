import { dateProperty, numeric, plain, relation, richText, title } from './notion.js';
import { canonicalId, createSerializer, createWriteGuard, dateOnly, inDatabase, madridToday, positive, WorkflowError } from './workflow.js';

function lastDay(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function occurrenceDate(firstDate, interval, month) {
  if (!firstDate || !Number.isSafeInteger(interval) || interval < 0) return null;
  const [year, number, day] = firstDate.split('-').map(Number);
  const [targetYear, targetMonth] = month.split('-').map(Number);
  const difference = (targetYear - year) * 12 + targetMonth - number;
  if (difference < 0 || (interval === 0 ? difference !== 0 : difference % interval !== 0)) return null;
  return `${month}-${String(Math.min(day, lastDay(targetYear, targetMonth))).padStart(2, '0')}`;
}

const relationId = prop => canonicalId(prop?.relation?.[0]?.id);
const filters = {
  expense: { property: 'Movimiento', select: { equals: 'Gasto' } },
  byMonth: prefix => ({ property: 'Clave de ocurrencia', rich_text: { contains: prefix } })
};
const unavailable = page => page.archived || page.in_trash;
const definitionLock = id => `definition:${id}`;

function payment(page) {
  const p = page.properties || {};
  return {
    id: canonicalId(page.id), concept: plain(p.Concepto), amount: numeric(p['Importe previsto']),
    firstDate: dateOnly(p['Primera fecha']?.date?.start), interval: numeric(p['Intervalo en meses']),
    category: plain(p['Categoría']), accountId: relationId(p['Cuenta habitual'])
  };
}

function movement(page) {
  const p = page.properties || {};
  const amount = numeric(p.Valor);
  return { id: canonicalId(page.id), concept: plain(p.Name), amount: Number.isFinite(amount) ? amount : null,
    date: p.Date?.date?.start?.slice(0, 10) || '', key: plain(p['Clave de ocurrencia']),
    type: plain(p.Movimiento), accountId: relationId(p['Cuenta bancaria']),
    linked: Boolean(plain(p['Clave de ocurrencia']) || p['Pago previsto']?.relation?.length || p['Fecha prevista']?.date) };
}

function publicExpense(row) {
  return { id: row.id, concept: row.concept, amount: row.amount, date: row.date, accountId: row.accountId };
}

function formValues(body) {
  const concept = typeof body.concept === 'string' ? body.concept.trim() : '';
  const { amount, interval, category } = body;
  const firstDate = dateOnly(body.firstDate);
  const accountId = canonicalId(body.accountId);
  if (!concept || concept.length > 2000 || !positive(amount) || !firstDate || !Number.isSafeInteger(interval) || interval < 0) {
    throw new WorkflowError(400, 'Completa el concepto, el importe, la fecha y la frecuencia del pago.');
  }
  return { concept, amount, firstDate, interval, category, accountId };
}

const matchesForm = (row, form) => Object.keys(form).every(key => row[key] === form[key]);
const paymentProperties = form => ({ Concepto: title(form.concept), 'Importe previsto': { number: form.amount },
  'Primera fecha': dateProperty(form.firstDate), 'Intervalo en meses': { number: form.interval },
  'Categoría': richText(form.category), 'Cuenta habitual': relation(form.accountId) });

export function createPayments({ notion, paymentsDb, movementsDb, accountsDb }) {
  const serial = createSerializer();
  const writeGuard = createWriteGuard();
  const definitions = new Map();
  const confirmed = new Map();
  const assigned = new Map();
  const removed = new Set();

  async function paymentPage(id) {
    const page = await notion.page(id);
    if (!inDatabase(page, paymentsDb)) throw new WorkflowError(404, 'El pago previsto no está disponible.');
    return page;
  }

  function paymentId(body) {
    const id = canonicalId(body.id);
    if (!id) throw new WorkflowError(400, 'Indica un pago previsto válido.');
    return id;
  }

  function remember(row) {
    confirmed.set(row.key, row);
    assigned.set(row.id, row.key);
    return publicExpense(row);
  }

  function observed(row) {
    const previous = confirmed.get(row.key);
    if (previous?.id !== row.id) return;
    confirmed.delete(row.key);
    assigned.delete(row.id);
  }

  async function options() {
    const [database, pages] = await Promise.all([notion.database(movementsDb), notion.query(accountsDb)]);
    const categories = database.properties?.Tipo?.select?.options?.map(option => option.name) || [];
    const accounts = pages.map(page => ({ id: canonicalId(page.id), name: plain(page.properties?.Cuenta) }))
      .filter(account => account.id && account.name);
    return { categories, accounts };
  }

  async function findOccurrence(body) {
    const id = canonicalId(body.id);
    const date = dateOnly(body.fechaPrevista);
    if (!id || !date) throw new WorkflowError(400, 'Indica el pago y la fecha de la ocurrencia.');
    const page = await paymentPage(id);
    if (unavailable(page) || removed.has(id)) throw new WorkflowError(404, 'El pago previsto no está disponible.');
    const row = payment(page);
    if (occurrenceDate(row.firstDate, row.interval, date.slice(0, 7)) !== date) throw new WorkflowError(400, 'La fecha no corresponde a este pago previsto.');
    return { ...row, date, key: `${id}:${date}` };
  }

  async function profile(accountId, category) {
    const setup = await options();
    if (!setup.accounts.some(account => account.id === accountId)) throw new WorkflowError(400, 'Elige una cuenta bancaria válida.');
    if (!setup.categories.includes(category)) throw new WorkflowError(400, 'Elige una categoría existente en Movimientos.');
  }

  async function byKey(key) {
    const prefix = key.slice(0, -2);
    const pages = await notion.query(movementsDb, { filter: filters.byMonth(prefix) });
    const published = pages.map(movement);
    const matches = published.filter(row => row.key === key);
    if ([...published, ...confirmed.values()].some(row => row.key !== key && row.key.startsWith(prefix) && dateOnly(row.key.split(':')[1]) && row.type === 'Gasto')) {
      throw new WorkflowError(409, 'Este pago ya tiene un gasto registrado para ese mes.');
    }
    if (matches.some(row => row.type !== 'Gasto') || matches.length > 1) throw new WorkflowError(409, 'La clave de la ocurrencia tiene un vínculo incompatible en Notion.');
    if (matches[0]) { observed(matches[0]); return matches[0]; }
    return confirmed.get(key);
  }

  const tracking = occurrence => ({ 'Pago previsto': relation(occurrence.id), 'Fecha prevista': dateProperty(occurrence.date),
    'Clave de ocurrencia': richText(occurrence.key) });

  return {
    async list(body) {
      const month = body.mes ?? madridToday().slice(0, 7);
      const start = `${month}-01`;
      if (typeof month !== 'string' || !dateOnly(start)) throw new WorkflowError(400, 'Indica un mes válido.');
      const [year, number] = month.split('-').map(Number);
      const end = `${month}-${lastDay(year, number)}`;
      const [definitions, expenses, setup] = await Promise.all([
        notion.query(paymentsDb, { filter: { property: 'Primera fecha', date: { on_or_before: end } } }),
        notion.query(movementsDb, { filter: { or: [
          { and: [filters.expense, { property: 'Fecha prevista', date: { on_or_after: start } },
            { property: 'Fecha prevista', date: { on_or_before: end } }] },
          { and: [filters.expense, { property: 'Clave de ocurrencia', rich_text: { contains: `:${month}-` } }] }
        ] } }),
        options()
      ]);
      const published = expenses.map(movement);
      published.forEach(observed);
      const active = new Map(definitions.filter(page => !unavailable(page) && !removed.has(canonicalId(page.id)))
        .map(payment).map(row => [row.id, row]));
      const paid = new Map([...confirmed.values(), ...published]
        .filter(row => row.type === 'Gasto' && row.key).map(row => [row.key, row]));
      const receipts = [...paid].flatMap(([key, expense]) => {
        const [id, date, extra] = key.split(':');
        if (extra !== undefined || canonicalId(id) !== id || !dateOnly(date) || !date.startsWith(`${month}-`)) return [];
        const definition = active.get(id);
        return [{ ...definition, id, concept: definition?.concept || expense.concept, amount: definition?.amount ?? expense.amount,
          date, definition: definition ?? null, paid: publicExpense(expense) }];
      });
      const paidIds = new Set(receipts.map(row => row.id));
      const occurrences = [...active.values()].flatMap(row => {
        const date = occurrenceDate(row.firstDate, row.interval, month);
        return row.id && date && positive(row.amount) && !paidIds.has(row.id)
          ? [{ ...row, date, definition: row, paid: null }] : [];
      }).concat(receipts).sort((a, b) => a.date.localeCompare(b.date) || a.concept.localeCompare(b.concept, 'es'));
      const pending = occurrences.filter(row => !row.paid).reduce((sum, row) => sum + Math.round(row.amount * 100), 0) / 100;
      return { month, occurrences, pending, ...setup };
    },
    async create(body) {
      const form = formValues(body);
      const { concept, firstDate, accountId, category } = form;
      const requestId = canonicalId(body.requestId);
      if (!requestId) throw new WorkflowError(400, 'Identificador de envío inválido.');
      const key = `payment:${requestId}`;
      return serial([key], async () => {
        const existing = definitions.get(key);
        if (existing) return existing;
        const lookup = async () => (await notion.query(paymentsDb, { filter: { and: [
          { property: 'Concepto', title: { equals: concept } }, { property: 'Primera fecha', date: { equals: firstDate } }
        ] } })).map(payment);
        let baseline;
        const saved = await writeGuard(key, [key], async () => {
          const matches = await lookup();
          if (!baseline) { baseline = new Set(matches.map(row => row.id)); return null; }
          return matches.find(row => !baseline.has(row.id) && matchesForm(row, form));
        }, async () => payment(await notion.create(paymentsDb, paymentProperties(form))), () => profile(accountId, category));
        definitions.set(key, saved);
        return saved;
      });
    },
    async edit(body) {
      const id = paymentId(body);
      const form = formValues(body);
      const scopes = [definitionLock(id)];
      return serial(scopes, () => writeGuard(`edit:${id}:${JSON.stringify(form)}`, scopes, async () => {
        const page = await paymentPage(id);
        if (unavailable(page) || removed.has(id)) throw new WorkflowError(404, 'El pago previsto no está disponible.');
        const row = payment(page);
        return matchesForm(row, form) ? row : null;
      }, async () => payment(await notion.update(id, paymentProperties(form))), () => profile(form.accountId, form.category)));
    },
    async archive(body) {
      const id = paymentId(body);
      const scopes = [definitionLock(id)];
      return serial(scopes, async () => {
        await writeGuard(`archive:${id}`, scopes, async () => {
          const page = await paymentPage(id);
          return (unavailable(page) || removed.has(id)) ? page : null;
        }, () => notion.archive(id));
        removed.add(id);
        return { id };
      });
    },
    async pay(body) {
      const scope = definitionLock(paymentId(body));
      return serial([scope], async () => {
        const occurrence = await findOccurrence(body);
        const lock = `occurrence:${occurrence.key}`;
        const row = await writeGuard(lock, [scope, lock], () => byKey(occurrence.key),
          async properties => movement(await notion.create(movementsDb, properties)), async () => {
          const date = dateOnly(body.date);
          const accountId = canonicalId(body.accountId);
          if (!date || !positive(body.amount)) throw new WorkflowError(400, 'Introduce un importe positivo y la fecha real del gasto.');
          await profile(accountId, occurrence.category);
          return { Name: title(occurrence.concept), Movimiento: { select: { name: 'Gasto' } },
            Valor: { number: body.amount }, Date: dateProperty(date), Tipo: { select: { name: occurrence.category } },
            'Cuenta bancaria': relation(accountId), ...tracking(occurrence) };
        });
        return remember(row);
      });
    },
    async candidates(body) {
      const occurrence = await findOccurrence(body);
      const pages = await notion.query(movementsDb, { filter: { and: [filters.expense,
        { property: 'Clave de ocurrencia', rich_text: { is_empty: true } }, { property: 'Pago previsto', relation: { is_empty: true } }
      ] } });
      const distance = row => row.date ? Math.abs(Date.parse(row.date) - Date.parse(occurrence.date)) : Infinity;
      return { candidates: pages.map(movement).filter(row => row.id && row.type === 'Gasto' && !row.linked && !assigned.has(row.id))
        .sort((a, b) => distance(a) - distance(b) || Math.abs((a.amount ?? Infinity) - occurrence.amount) - Math.abs((b.amount ?? Infinity) - occurrence.amount))
        .map(publicExpense) };
    },
    async link(body) {
      const scope = definitionLock(paymentId(body));
      const expenseId = canonicalId(body.expenseId);
      if (!expenseId) throw new WorkflowError(400, 'Elige el gasto que quieres vincular.');
      const scopes = [scope, `expense:${expenseId}`];
      return serial(scopes, async () => {
        const occurrence = await findOccurrence(body);
        const row = await writeGuard(`link:${occurrence.key}:${expenseId}`, scopes, async () => {
          const existing = await byKey(occurrence.key);
          if (existing && existing.id !== expenseId) throw new WorkflowError(409, 'La ocurrencia ya está vinculada a otro gasto.');
          if (existing) return existing;
          if (assigned.has(expenseId)) throw new WorkflowError(409, 'Ese gasto ya está vinculado a otra ocurrencia.');
          const page = await notion.page(expenseId);
          const candidate = movement(page);
          if (!inDatabase(page, movementsDb) || candidate.type !== 'Gasto' || page.archived || page.in_trash) throw new WorkflowError(400, 'Selecciona un gasto disponible.');
          if (candidate.key === occurrence.key) return candidate;
          if (candidate.linked) throw new WorkflowError(409, 'Ese gasto ya está vinculado a otra ocurrencia.');
          return null;
        }, async () => movement(await notion.update(expenseId, tracking(occurrence))));
        return remember(row);
      });
    }
  };
}
