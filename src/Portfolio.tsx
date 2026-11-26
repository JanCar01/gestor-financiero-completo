import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Plus, TrendingUp } from 'lucide-react';
import { ActionDialog, useAction } from './ActionDialog';
import { displayDate, money, submitOnce } from './api';

export type Fund = {
  id: string;
  nombre: string;
  isin: string;
  divisa: string;
  participaciones: number | null;
  valor: number | null;
  costeRestante: number | null;
  ganancia: number | null;
  rentabilidad: number | null;
  problema?: string;
  valoracion: { fechaValoracion: string; fuente: 'Quefondos' | 'Vanguard España' | 'Finect'; valorLiquidativo: number; variacionDiaria: number | null } | null;
  valoracionGuardada: boolean;
};

export type PortfolioSummary = {
  valor: number | null; costeRestante: number | null; ganancia: number | null; rentabilidad: number | null;
  parcial: boolean; valorados: number; posiciones: number;
};
const percent = new Intl.NumberFormat('es-ES', {
  style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero'
});
const tone = (change: number | null) => change === null || change === 0 ? '' : change > 0 ? 'positive' : 'negative';
const amount = (value: number | null, currency = 'EUR', signed = false) => value === null ? '—' : money(value, currency, signed);
const rate = (value: number | null) => value === null ? '—' : percent.format(value / 100);
const quantity = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 20 });

type Props = { funds: Fund[] | null; summary: PortfolioSummary | null; error: string; loading: boolean; today: string; onChanged: () => void };

export function Portfolio({ funds, summary, error, loading, today, onChanged }: Props) {
  const [registering, setRegistering] = useState(false);
  const gain = summary?.ganancia ?? null;

  return <article className="panel portfolio" aria-labelledby="portfolio-title" aria-busy={loading}>
    <div className="panel-heading portfolio-heading">
      <div><h2 id="portfolio-title"><TrendingUp size={23} aria-hidden="true"/> Tus inversiones</h2>
        <p>Cartera de fondos de MyInvestor</p></div>
      <button className="secondary-btn" disabled={!funds?.length} onClick={() => setRegistering(true)}><Plus size={16}/> Registrar operación</button>
    </div>
    <div className="portfolio-balance">
      <span>{summary?.parcial ? 'Valor disponible en EUR' : 'Valor actual de la cartera'}</span>
      <strong>{amount(summary?.valor ?? null)}</strong>
      {summary?.parcial && <small>{summary.valorados} de {summary.posiciones} posiciones abiertas valoradas</small>}
    </div>
    <dl className="portfolio-totals">
      <div><dt>Total invertido</dt><dd>{amount(summary?.costeRestante ?? null)}</dd></div>
      <div>
        <dt>Rentabilidad de las posiciones</dt>
        <dd className={tone(gain)}>{amount(gain, 'EUR', true)}
          {gain !== null && <small>{rate(summary?.rentabilidad ?? null)}</small>}
        </dd>
      </div>
    </dl>
    {error && <p className="alert soft" role="status">{error}</p>}
    {funds === null && !error && <p className="portfolio-status" role="status">Consultando fondos de inversión…</p>}
    {funds?.length === 0 && <p className="portfolio-status">No hay fondos registrados en Notion.</p>}
    {funds && funds.length > 0 && <>
      <div className="portfolio-list-heading"><h3>Fondos</h3><span>Variación de 1 día</span></div>
      <ul className="fund-list">
        {funds.map(fund => {
          const daily = fund.valoracion?.variacionDiaria ?? null;
          const issues = [
            fund.problema || (fund.participaciones === null && 'Participaciones pendientes en Notion'),
            !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(fund.isin) && 'Revisa el ISIN en Notion',
            !/^[A-Z]{3}$/.test(fund.divisa) && 'Revisa la divisa en Notion',
            !fund.valoracion && fund.participaciones !== 0 && 'Valoración no disponible'
          ].filter(Boolean);
          const date = fund.valoracion && displayDate(fund.valoracion.fechaValoracion);
          const currency = /^[A-Z]{3}$/.test(fund.divisa) ? fund.divisa : 'EUR';
          return <li key={fund.id} className="fund-row">
            <div className="fund-details">
              <strong>{fund.nombre}</strong>
              <small>{[fund.isin, date && `${fund.valoracionGuardada ? 'Último dato guardado' : 'Valoración'} ${date}`, fund.valoracion?.fuente].filter(Boolean).join(' · ')}</small>
              <small>{fund.participaciones === null ? '—' : quantity.format(fund.participaciones)} participaciones · Coste {amount(fund.costeRestante)}</small>
              {issues.length > 0 && <small className="fund-issue">{issues.join(' · ')}</small>}
            </div>
            <div className="fund-numbers">
              <strong>{amount(fund.valor, currency)}</strong>
              <small className={`fund-gain ${tone(fund.ganancia)}`}>Resultado {amount(fund.ganancia, 'EUR', true)} · {rate(fund.rentabilidad)}</small>
              <small className={`fund-change ${tone(daily)}`}>
                {daily === null ? 'Sin dato diario' : daily === 0 ? 'Sin cambio' : <>
                  {daily > 0 ? <ArrowUpRight size={15} aria-hidden="true"/> : <ArrowDownRight size={15} aria-hidden="true"/>}
                  {daily > 0 ? 'Sube' : 'Baja'} {percent.format(daily / 100)}
                </>}
              </small>
            </div>
          </li>;
        })}
      </ul>
      {summary?.parcial && <p className="portfolio-status">La rentabilidad total requiere una valoración en euros de todas las posiciones abiertas.</p>}
      {summary?.costeRestante === null && <p className="portfolio-status">Completa los costes de apertura pendientes en Notion.</p>}
    </>}
    {registering && Boolean(funds?.length) && <FundOperationDialog funds={funds!} today={today} onClose={() => setRegistering(false)} onDone={() => {
      setRegistering(false);
      onChanged();
    }}/>}
  </article>;
}

function FundOperationDialog({ funds, today, onClose, onDone }: { funds: Fund[]; today: string; onClose: () => void; onDone: () => void }) {
  const [fundId, setFundId] = useState(funds[0].id);
  const [type, setType] = useState('Compra');
  const [date, setDate] = useState(today);
  const [shares, setShares] = useState('');
  const [total, setTotal] = useState('');
  const action = useAction(onDone);
  return <ActionDialog title="Registrar operación" busy={action.busy} uncertain={action.uncertain} error={action.error}
    submitLabel="Guardar operación" onClose={onClose} onSubmit={() => void action.run(() => submitOnce('fondos/operaciones', 'Registrar operación',
      { fundId, type, date, shares: Number(shares), amount: Number(total) }, 'key'))}>
    <label>Fondo<select value={fundId} required onChange={event => setFundId(event.target.value)}>
      {funds.map(fund => <option key={fund.id} value={fund.id}>{fund.nombre}</option>)}
    </select></label>
    <label>Tipo<select value={type} onChange={event => setType(event.target.value)}><option>Compra</option><option>Venta</option></select></label>
    <label>Fecha efectiva<input type="date" required max={today} value={date} onChange={event => setDate(event.target.value)}/></label>
    <label>Participaciones<input type="number" required min="0" step="any" value={shares} onChange={event => setShares(event.target.value)}/></label>
    <label>{type === 'Compra' ? 'Coste total pagado (€)' : 'Importe neto recibido (€)'}<input type="number" required min="0.01" step="0.01" value={total} onChange={event => setTotal(event.target.value)}/></label>
  </ActionDialog>;
}
