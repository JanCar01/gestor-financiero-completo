import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Download, ExternalLink, LayoutDashboard, RefreshCw, Search, SlidersHorizontal, Wallet } from 'lucide-react';
import { Portfolio, type Fund, type PortfolioSummary } from './Portfolio';
import { Payments } from './Payments';
import { madridToday, money as euro, query } from './api';
import './App.css';

type Movement = { url?: string; Name: string; Movimiento: string; Tipo: string; Valor: number; 'date:Date:start'?: string };
type Account = { id?: string; nombre: string; saldo: number; moneda?: string };
const palette = ['#2563eb', '#60a5fa', '#0ea5e9', '#818cf8', '#38bdf8', '#1d4ed8', '#93c5fd'];
const sum = (items: Movement[]) => items.reduce((total, item) => total + Math.round(item.Valor * 100), 0) / 100;
function parseAccounts(data: any): Account[] {
  const items = Array.isArray(data) ? data : data?.cuentas ?? data?.accounts ?? data?.results;
  if (!Array.isArray(items)) throw new Error('La respuesta no contiene una lista de cuentas.');
  return items.map((item: any) => {
    const p = item.properties;
    const nombre = item.nombre ?? item.name ?? p?.Nombre?.title?.map((t: any) => t.plain_text).join('') ?? p?.Name?.title?.map((t: any) => t.plain_text).join('');
    const saldo = item.saldo ?? item.saldoActual ?? item['Saldo actual'] ?? p?.['Saldo actual']?.formula?.number ?? p?.['Saldo actual']?.number;
    return { id: item.id, nombre: String(nombre || 'Cuenta sin nombre'), saldo: Number(saldo), moneda: item.moneda || 'EUR' };
  }).filter((a: Account) => Number.isFinite(a.saldo));
}
export default function App() {
  const [rows, setRows] = useState<Movement[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [funds, setFunds] = useState<Fund[] | null>(null);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [accountsError, setAccountsError] = useState('');
  const [fundsError, setFundsError] = useState('');
  const [updated, setUpdated] = useState('');
  const [category, setCategory] = useState('Todas');
  const [movementType, setMovementType] = useState('Todos');
  const [search, setSearch] = useState('');
  const [period, setPeriod] = useState('mes');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [tab, setTab] = useState('Resumen');
  async function load() {
    refresh.current?.abort();
    const controller = new AbortController();
    refresh.current = controller;
    const { signal } = controller;
    setLoading(true); setError(''); setAccountsError(''); setFundsError('');
    setFunds(null); setSummary(null);
    setVersion(current => current + 1);
    await Promise.all([
      query('movimientos', 'Movimientos', signal).then(data => {
        if (!Array.isArray(data.results) || data.has_more) throw new Error('La respuesta de movimientos no es válida o hay más páginas pendientes.');
        setRows(data.results.filter((r: Movement) => r.Movimiento && Number.isFinite(r.Valor)));
        setUpdated(new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }));
      }).catch(err => {
        if (!signal?.aborted) setError(err.message || 'No se pudieron cargar los movimientos.');
      }),
      query('cuentas', 'Cuentas', signal).then(data => {
        setAccounts(parseAccounts(data));
      }).catch(err => {
        if (!signal?.aborted) setAccountsError(err.message || 'No se pudieron consultar las cuentas.');
      }),
      query<{ fondos: Fund[]; resumen: PortfolioSummary }>('fondos', 'Fondos', signal).then(data => {
        if (!Array.isArray(data.fondos)) throw new Error('La respuesta no contiene una lista de fondos.');
        setFunds(data.fondos);
        setSummary(data.resumen);
      }).catch(err => {
        if (!signal?.aborted) setFundsError(`No se pudieron consultar los fondos. ${err.message || ''}`.trim());
      })
    ]);
    if (!signal?.aborted) setLoading(false);
  }
  useEffect(() => {
    void load();
    return () => refresh.current?.abort();
  }, []);
  const today = madridToday();
  const effectiveStart = period === 'mes' ? `${today.slice(0,7)}-01` : period === 'custom' ? start : '';
  const effectiveEnd = period === 'mes' ? `${today.slice(0,7)}-${new Date(Number(today.slice(0,4)), Number(today.slice(5,7)), 0).getDate()}` : period === 'custom' ? end || (start ? today : '') : '';
  const invalidDateRange = Boolean(effectiveStart && effectiveEnd && effectiveStart > effectiveEnd);
  const filtered = useMemo(() => rows.filter(r => {
    const d = (r['date:Date:start'] || '').slice(0,10);
    if ((effectiveStart || effectiveEnd) && (!d || (effectiveStart && d < effectiveStart) || (effectiveEnd && d > effectiveEnd))) return false;
    return (category === 'Todas' || r.Tipo === category) && (movementType === 'Todos' || r.Movimiento === movementType) && (!search || `${r.Name} ${r.Tipo}`.toLowerCase().includes(search.toLowerCase()));
  }), [rows, effectiveStart, effectiveEnd, category, movementType, search]);
  const expenses = filtered.filter(r => r.Movimiento === 'Gasto' && r.Tipo !== 'Inversion');
  const income = sum(filtered.filter(r => r.Movimiento === 'Ingreso'));
  const spent = sum(expenses);
  const transfers = sum(filtered.filter(r => r.Movimiento === 'Transferencia'));
  const categories = Object.entries(expenses.reduce((acc, r) => { const key = r.Tipo || 'Sin categoría'; acc[key] = (acc[key] || 0) + Math.round(r.Valor * 100); return acc; }, {} as Record<string, number>)).map(([name, cents]) => ({ name, value: cents / 100 })).sort((a,b) => b.value - a.value);
  let degree = 0;
  const gradient = categories.map((item,i) => { const from = degree; degree += spent ? item.value / spent * 100 : 0; return `${palette[i % palette.length]} ${from}% ${degree}%`; }).join(',');
  const totalAccounts = accounts.filter(a => a.moneda === 'EUR').reduce((acc,a) => acc + a.saldo,0);
  function exportCSV() {
    const lines = ['Fecha;Concepto;Movimiento;Categoría;Importe', ...filtered.map(r => [r['date:Date:start'] || '',r.Name,r.Movimiento,r.Tipo,r.Valor].map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(';'))];
    const url = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\n')], {type:'text/csv;charset=utf-8'}));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'movimientos.csv'; anchor.click(); URL.revokeObjectURL(url);
  }
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">◈</span> Mi Balance</div><div className="sidebar-label">MI ESPACIO</div>
      <button className={`nav-item ${tab === 'Resumen' ? 'active' : ''}`} onClick={() => setTab('Resumen')}><LayoutDashboard size={21}/> Resumen</button>
      <button className={`nav-item ${tab === 'Movimientos' ? 'active' : ''}`} onClick={() => setTab('Movimientos')}><ArrowLeftRight size={21}/> Movimientos</button>
      <a className="nav-item" href="https://www.notion.so/406e79e93d2d80fd85bacdb85b526139" target="_blank" rel="noreferrer"><ExternalLink size={21}/> Abrir Notion</a>
      <div className="sidebar-help"><strong>Datos sincronizados con Notion</strong><p>Registra tus operaciones y pulsa Actualizar para consultar los últimos cambios.</p></div>
    </aside>
    <div className={`dashboard-layout ${tab === 'Resumen' ? 'with-payments' : ''}`}>
    <main className="main"><header className="topbar"><span>Finanzas personales / {tab}</span><span className="local-badge">Panel personal</span></header>
      <section className="hero"><div><span className="eyebrow">CONTROL FINANCIERO</span><h1>{tab === 'Resumen' ? 'Tu dinero, más claro.' : 'Todos tus movimientos.'}</h1><p>Consulta tus cuentas, movimientos e inversiones.</p></div><button className="primary-btn" disabled={loading} onClick={() => void load()}><RefreshCw size={19} className={loading ? 'spin' : ''}/>{loading ? 'Actualizando...' : 'Actualizar datos'}</button></section>
      {error && <div className="alert" role="alert">{error}</div>}
      <section className="filters">
        <div className="filter-heading"><SlidersHorizontal size={19}/> Filtros</div>
        <label>Periodo<select value={period} onChange={e => setPeriod(e.target.value)}><option value="mes">Este mes</option><option value="all">Todo el historial</option><option value="custom">Personalizado</option></select></label>
        {period === 'custom' && <>
        <label>Desde<input type="date" value={start} max={end || today} onChange={e => setStart(e.target.value)} aria-describedby="date-range-help" aria-invalid={invalidDateRange}/></label>
        <label>Hasta<input type="date" value={effectiveEnd} min={start || undefined} onChange={e => setEnd(e.target.value)} aria-describedby="date-range-help" aria-invalid={invalidDateRange}/></label>
        {(start || end) && <button className="secondary-btn" onClick={() => { setStart(''); setEnd(''); }}>Limpiar fechas</button>}
        </>}
        <label>Categoría<select value={category} onChange={e => setCategory(e.target.value)}><option>Todas</option>{Array.from(new Set(rows.map(r => r.Tipo).filter(Boolean))).sort().map(c => <option key={c}>{c}</option>)}</select></label>
        <label>Movimiento<select value={movementType} onChange={e => setMovementType(e.target.value)}><option>Todos</option><option>Gasto</option><option>Ingreso</option><option>Transferencia</option></select></label>
        <span className="last-update">{updated ? `Actualizado a las ${updated}` : 'Sin sincronizar'}</span>
        {period === 'custom' && <p className="date-range-help" id="date-range-help">Sin fechas se muestra todo el historial. Si solo indicas Desde, se incluyen los movimientos hasta hoy.</p>}
      </section>
      {invalidDateRange && <div className="alert" role="alert">La fecha Desde debe ser anterior o igual a Hasta.</div>}
      {tab === 'Resumen' && <>
        <section className="account-section"><div className="section-title"><div><h2><Wallet size={25}/> Tus cuentas bancarias</h2><p>Saldos actuales obtenidos de Notion, independientes de los filtros de movimientos.</p></div></div>
          {accountsError && <div className="alert soft">No se han podido cargar los saldos: {accountsError}. Configura el endpoint <code>/api/cuentas</code>.</div>}
          <div className="accounts-grid"><article className="account-card total"><span>Saldo total en cuentas (EUR)</span><strong>{accounts.length ? euro(totalAccounts) : '—'}</strong><small>No incluye el valor de las inversiones.</small></article>{accounts.map((account,i) => <article className="account-card" key={account.id || account.nombre}><span><span className="account-dot" style={{background:palette[i % palette.length]}}/>{account.nombre}</span><strong>{account.moneda === 'EUR' ? euro(account.saldo) : `${account.saldo.toLocaleString('es-ES')} ${account.moneda}`}</strong><small>Saldo actual</small></article>)}</div>
          {!accounts.length && !accountsError && <p className="empty-message">{loading ? 'Cargando cuentas...' : 'No hay cuentas disponibles.'}</p>}
        </section>
        <section className="metrics">{[{label:'Ingresos',value:income,icon:<ArrowDownLeft size={22}/>,note:'Entradas del periodo'},{label:'Gastos',value:spent,icon:<ArrowUpRight size={22}/>,note:'Sin aportaciones a inversión'}].map(m => <article className="metric" key={m.label}><div className="metric-label">{m.label}<span>{m.icon}</span></div><strong>{updated ? euro(m.value) : '—'}</strong><small>{m.note}</small></article>)}</section>
        <section className="charts"><article className="panel"><div className="panel-heading"><h2>¿Dónde se va tu dinero?</h2><p>Gastos por categoría</p></div>{category !== 'Todas' && <div className="chart-filter"><span>Categoría: <strong>{category}</strong></span><button className="secondary-btn" onClick={() => setCategory('Todas')}>Quitar filtro</button></div>}<div className="donut-layout"><div className="donut" style={{background: gradient ? `conic-gradient(${gradient})` : '#dbeafe'}}><div><small>TOTAL GASTADO</small><strong>{updated ? euro(spent) : '—'}</strong></div></div><div className="legend">{categories.map((c,i) => <button key={c.name} aria-pressed={category === c.name} onClick={() => setCategory(current => current === c.name ? 'Todas' : c.name)}><i style={{background:palette[i % palette.length]}}/><span>{c.name}</span><strong>{euro(c.value)}</strong><small>{spent ? (c.value / spent * 100).toFixed(0) : '0'}%</small></button>)}{!categories.length && <p>Sin gastos en el periodo.</p>}</div></div></article>
          <Portfolio funds={funds} summary={summary} error={fundsError} loading={loading} today={today} onChanged={() => void load()}/>
        </section>
        <div className="transfer-info"><ArrowLeftRight size={23}/><div><strong>Transferencias internas</strong><p>{euro(transfers)} registrados como transferencias. No se suman a gastos ni ingresos.</p></div></div>
      </>}
      <section className="panel transactions"><div className="transactions-header"><div><h2>Detalle de movimientos</h2><p>{filtered.length} movimientos encontrados</p></div><button className="secondary-btn" onClick={exportCSV} disabled={!updated}><Download size={19}/> Exportar CSV</button></div><div className="search-box"><Search size={20}/><input aria-label="Buscar movimientos" placeholder="Buscar por concepto o categoría..." value={search} onChange={e => setSearch(e.target.value)}/>{(search || category !== 'Todas' || movementType !== 'Todos') && <button onClick={() => {setSearch('');setCategory('Todas');setMovementType('Todos');}}>Limpiar</button>}</div><div className="table-scroll"><table><thead><tr><th>Concepto</th><th>Fecha</th><th>Categoría</th><th>Movimiento</th><th className="amount">Importe</th></tr></thead><tbody>{filtered.map((r,i) => <tr key={r.url || i}><td>{r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.Name || 'Sin concepto'} <ExternalLink size={14}/></a> : r.Name || 'Sin concepto'}</td><td>{r['date:Date:start']?.slice(0,10).split('-').reverse().join('/') || 'Sin fecha'}</td><td><span className="category-tag">{r.Tipo || '—'}</span></td><td><span className={`movement-tag ${r.Movimiento.toLowerCase()}`}>{r.Movimiento}</span></td><td className={`amount ${r.Movimiento === 'Ingreso' ? 'positive' : ''}`}>{r.Movimiento === 'Ingreso' ? '+' : r.Movimiento === 'Gasto' ? '−' : ''}{euro(r.Valor)}</td></tr>)}{!filtered.length && <tr><td className="empty-message" colSpan={5}>{loading ? 'Cargando movimientos...' : 'No hay movimientos para estos filtros.'}</td></tr>}</tbody></table></div></section>
      <footer>Mi Balance</footer>
    </main>
    {tab === 'Resumen' && <Payments today={today} version={version} onChanged={() => void load()}/>}
    </div>
  </div>;
}
