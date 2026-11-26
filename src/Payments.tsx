import { useEffect, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { ActionDialog, useAction } from './ActionDialog';
import { displayDate, money, query, submitOnce } from './api';

type Account = { id: string; name: string };
type Expense = { id: string; concept: string; date: string; amount: number | null; accountId: string | null };
type Definition = { id: string; concept: string; amount: number; firstDate: string; interval: number; category: string; accountId: string | null };
type Occurrence = { id: string; concept: string; date: string; amount: number | null; definition: Definition | null; paid: Expense | null };
type MonthData = { month: string; accounts: Account[]; categories: string[]; pending: number; occurrences: Occurrence[] };
type Mode = { type: 'new' } | { type: 'pay' | 'link'; row: Occurrence } | { type: 'edit' | 'delete'; definition: Definition };
const formatAmount = (value: number | null) => value === null ? '—' : money(value);

function nextMonth(month: string, offset: number) {
  const [year, value] = month.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, value - 1 + offset, 1);
  return date.toISOString().slice(0, 7);
}

export function Payments({ today, version, onChanged }: { today: string; version: number; onChanged: () => void }) {
  const current = today.slice(0, 7);
  const [month, setMonth] = useState(current);
  const [data, setData] = useState<MonthData | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<Mode | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    query<MonthData>('pagos', 'Pagos previstos', controller.signal, { mes: month }).then(setData).catch(error => {
      if (!controller.signal.aborted) setError(error.message);
    });
    return () => controller.abort();
  }, [month, version]);
  const visible = data?.month === month ? data : null;
  const label = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));

  return <aside className="panel payments-panel" aria-labelledby="payments-title">
    <div className="payments-heading">
      <h2 id="payments-title"><CalendarDays size={21} aria-hidden="true"/> Pagos previstos</h2>
      <button className="secondary-btn" disabled={!visible} onClick={() => setMode({ type: 'new' })}><Plus size={16}/> Nuevo pago</button>
    </div>
    <div className="month-navigation">
      <button className="secondary-btn" aria-label="Mes anterior" onClick={() => setMonth(nextMonth(month, -1))}><ChevronLeft size={18}/></button>
      <strong>{label}</strong>
      <button className="secondary-btn" aria-label="Mes siguiente" onClick={() => setMonth(nextMonth(month, 1))}><ChevronRight size={18}/></button>
    </div>
    {month !== current && <button className="text-button" onClick={() => setMonth(current)}>Volver al mes actual</button>}
    {error && <p className="alert" role="alert">{error}</p>}
    {!visible && !error && <p className="portfolio-status" role="status">Consultando pagos…</p>}
    {visible && <>
      <div className="payments-total"><span>Total pendiente</span><strong>{money(visible.pending)}</strong></div>
      {!visible.occurrences.length && <p className="portfolio-status">No hay pagos previstos este mes.</p>}
      <ul className="payments-list">
        {visible.occurrences.map(row => <li key={`${row.id}:${row.date}`} className="payment-row">
          <div className="payment-detail">
            <div><strong>{row.concept}</strong><small>{displayDate(row.date)}</small></div>
            <div><strong>{formatAmount(row.paid?.amount ?? row.amount)}</strong>
              <small className={row.paid ? 'positive' : ''}>{row.paid ? 'Pagado' : 'Pendiente'}</small></div>
          </div>
          {row.paid?.date && <small className="paid-date">Gasto registrado el {displayDate(row.paid.date)}</small>}
          <div className="payment-actions">
          {!row.paid && <>
            <button className="text-button" onClick={() => setMode({ type: 'pay', row })}>Marcar como pagado</button>
            <button className="text-button" onClick={() => setMode({ type: 'link', row })}>Vincular gasto existente</button>
          </>}
          {row.definition && <>
            <button className="text-button" onClick={() => setMode({ type: 'edit', definition: row.definition! })}>Editar</button>
            <button className="text-button payment-delete" onClick={() => setMode({ type: 'delete', definition: row.definition! })}>Eliminar</button>
          </>}
          </div>
        </li>)}
      </ul>
    </>}
    {visible && mode && <PaymentDialog mode={mode} setup={visible} today={today} onClose={() => setMode(null)} onDone={() => {
      setMode(null);
      onChanged();
    }}/>}
  </aside>;
}

function PaymentDialog({ mode, setup, today, onClose, onDone }: {
  mode: Mode; setup: MonthData; today: string; onClose: () => void; onDone: () => void;
}) {
  const row = 'row' in mode ? mode.row : null;
  const definition = 'definition' in mode ? mode.definition : null;
  const [concept, setConcept] = useState(definition?.concept ?? '');
  const [amount, setAmount] = useState(String(definition?.amount ?? row?.amount ?? ''));
  const [date, setDate] = useState(definition?.firstDate ?? today);
  const [category, setCategory] = useState(definition?.category ?? '');
  const [accountId, setAccountId] = useState(definition?.accountId ?? row?.definition?.accountId ?? '');
  const [repeats, setRepeats] = useState((definition?.interval ?? 0) > 0);
  const [interval, setInterval] = useState(String(definition?.interval || 1));
  const [candidates, setCandidates] = useState<Expense[] | null>(null);
  const [candidateError, setCandidateError] = useState('');
  const [search, setSearch] = useState('');
  const [expenseId, setExpenseId] = useState('');
  const action = useAction(onDone);

  useEffect(() => {
    if (mode.type !== 'link') return;
    const controller = new AbortController();
    query<{ candidates: Expense[] }>('pagos/candidatos', 'Gastos existentes', controller.signal, { id: mode.row.id, fechaPrevista: mode.row.date })
      .then(data => setCandidates(data.candidates)).catch(error => {
        if (!controller.signal.aborted) setCandidateError(error.message);
      });
    return () => controller.abort();
  }, [mode]);

  function submit() {
    return action.run(async () => {
      if (mode.type === 'new' || mode.type === 'edit') {
        const data = { concept: concept.trim(), amount: Number(amount), firstDate: date, category, accountId, interval: repeats ? Number(interval) : 0 };
        return mode.type === 'edit' ? query('pagos/editar', 'Editar pago', undefined, { ...data, id: mode.definition.id })
          : submitOnce('pagos/crear', 'Nuevo pago', data, 'requestId');
      }
      if (mode.type === 'delete') return query('pagos/eliminar', 'Eliminar pago', undefined, { id: mode.definition.id });
      if (!('row' in mode)) return;
      const occurrence = { id: mode.row.id, fechaPrevista: mode.row.date };
      if (mode.type === 'pay') return query('pagos/pagar', 'Confirmar pago', undefined, { ...occurrence, amount: Number(amount), date, accountId });
      return query('pagos/vincular', 'Vincular gasto', undefined, { ...occurrence, expenseId });
    });
  }

  const title = { new: 'Nuevo pago previsto', edit: 'Editar pago previsto', delete: 'Eliminar pago previsto', pay: 'Confirmar pago', link: 'Vincular gasto existente' }[mode.type];
  const template = mode.type === 'new' || mode.type === 'edit';
  const match = candidates?.filter(item => `${item.concept} ${item.date} ${displayDate(item.date)} ${item.amount ?? ''} ${item.amount === null ? '' : money(item.amount)}`
    .toLocaleLowerCase('es-ES').includes(search.trim().toLocaleLowerCase('es-ES'))) ?? [];
  return <ActionDialog title={title} busy={action.busy} uncertain={action.uncertain} error={action.error || candidateError}
    submitLabel={mode.type === 'delete' ? 'Eliminar pago' : mode.type === 'link' ? 'Vincular gasto' : 'Guardar'} onClose={onClose} onSubmit={() => void submit()}
    disabled={mode.type === 'link' ? !expenseId : mode.type !== 'delete' && (!setup.accounts.length || (template && !setup.categories.length))}>
    {row && <p className="dialog-context">{row.concept} · {displayDate(row.date)} · {formatAmount(row.amount)} previsto</p>}
    {mode.type === 'delete' ? <p className="dialog-context">Se retirará <strong>{mode.definition.concept}</strong> de la planificación. Los gastos ya registrados seguirán en el historial.</p> : mode.type === 'link' ? <>
      {!candidates && !candidateError && <p role="status">Buscando gastos disponibles…</p>}
      {candidates && !candidates.length && <p>No hay gastos disponibles para vincular.</p>}
      {Boolean(candidates?.length) && <>
        <label>Buscar por concepto, fecha o importe<input value={search} onChange={event => { setSearch(event.target.value); setExpenseId(''); }}/></label>
        <label>Gasto<select required value={expenseId} onChange={event => setExpenseId(event.target.value)}>
          <option value="">{match.length ? 'Selecciona un gasto' : 'Sin coincidencias'}</option>
          {match.map(item => <option key={item.id} value={item.id}>
            {item.date ? displayDate(item.date) : 'Sin fecha'} · {item.concept || 'Sin concepto'} · {item.amount === null ? 'Sin importe' : money(item.amount)}
          </option>)}
        </select></label>
      </>}
    </> : <>
      {template && <label>Concepto<input required maxLength={2000} value={concept} onChange={event => setConcept(event.target.value)}/></label>}
      <label>{mode.type === 'pay' ? 'Importe real (€)' : 'Importe previsto (€)'}<input required type="number" min="0.01" step="0.01" value={amount} onChange={event => setAmount(event.target.value)}/></label>
      <label>{mode.type === 'pay' ? 'Fecha real' : 'Primera fecha'}<input required type="date" value={date} onChange={event => setDate(event.target.value)}/></label>
      {template && <label>Categoría<select required value={category} onChange={event => setCategory(event.target.value)}>
        <option value="">Selecciona una categoría</option>{setup.categories.map(value => <option key={value}>{value}</option>)}
      </select></label>}
      <label>{mode.type === 'pay' ? 'Cuenta real' : 'Cuenta habitual'}<select required value={accountId} onChange={event => setAccountId(event.target.value)}>
        <option value="">Selecciona una cuenta</option>{setup.accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
      </select></label>
      {template && <>
        <label className="checkbox-field"><input type="checkbox" checked={repeats} onChange={event => setRepeats(event.target.checked)}/> Repetir</label>
        {repeats && <label>Cada cuántos meses<input required type="number" min="1" step="1" value={interval} onChange={event => setInterval(event.target.value)}/></label>}
      </>}
    </>}
  </ActionDialog>;
}
