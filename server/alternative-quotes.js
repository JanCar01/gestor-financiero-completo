import { calendarDate, loadHtml, localizedNumber } from './quote-format.js';

const sources = new Map([
  ['IE0007987708', {
    name: 'Vanguard España', parse: readVanguard,
    url: 'https://www.es.vanguard/profesionales/producto/fondo/renta-variable/9922/vanguard-european-stock-index-fund-eur-acc'
  }],
  ['IE0031786142', {
    name: 'Vanguard España', parse: readVanguard,
    url: 'https://www.es.vanguard/profesionales/producto/fondo/renta-variable/9115/emerging-markets-stock-index-fund-eur'
  }],
  ['IE00BYX5NX33', {
    name: 'Finect', parse: readFinect,
    url: 'https://www.finect.com/fondos-inversion/IE00BYX5NX33-Fidelity_msci_world_index_eur_p_acc'
  }]
]);

const months = 'ene feb mar abr may jun jul ago sep oct nov dic'.split(' ');

function readVanguard($, isin) {
  if ($('meta[name="isin"]').attr('content') !== isin || $('meta[name="currency"]').attr('content') !== 'EUR') return null;
  const sections = $('europe-core-historical-prices').filter((_, section) =>
    $(section).find('h5').first().text().trim() === 'Precios históricos');
  const table = sections.find('table').filter((_, node) => {
    const columns = $(node).find('thead th').map((_, cell) => $(cell).text().trim()).get();
    return columns[0] === 'Fecha' && columns[1] === 'Valor de activos neto (EUR)';
  });
  if (table.length !== 1) return null;
  const rows = table.find('tbody > tr').map((_, row) => {
    const cells = $(row).children('th, td');
    const date = cells.eq(0).text().trim().match(/^(\d{1,2})\s+([a-z]{3,4})\.?\s+(\d{4})$/i);
    const month = date ? months.indexOf(date[2].toLowerCase().slice(0, 3)) + 1 : 0;
    const fechaValoracion = month ? calendarDate(date[3], month, date[1]) : null;
    const price = cells.eq(1).text().trim().match(/^(.+?)\s*€$/);
    const valorLiquidativo = localizedNumber(price?.[1], 'es');
    return fechaValoracion ? { fechaValoracion, valorLiquidativo } : null;
  }).get().sort((a, b) => b.fechaValoracion.localeCompare(a.fechaValoracion));

  const latest = rows.find(row => row.valorLiquidativo > 0);
  if (!latest) return null;
  const previous = rows.find(row => row.fechaValoracion < latest.fechaValoracion);
  const change = previous?.valorLiquidativo > 0
    ? (latest.valorLiquidativo - previous.valorLiquidativo) / previous.valorLiquidativo * 100
    : null;
  return { ...latest, variacionDiaria: Number.isFinite(change) ? change : null };
}

function readFinect($, isin) {
  const prefix = /^window\.INITIAL_STATE\s*=\s*/;
  const script = $('script').toArray().map(node => $(node).text().trim()).find(text => prefix.test(text));
  if (!script) return null;
  let state;
  try {
    const payload = JSON.parse(script.replace(prefix, '').replace(/;$/, ''));
    state = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch { return null; }
  const fund = state?.fund?.fund?.model;
  if (fund?.isin !== isin || fund.currency?.code !== 'EUR') return null;
  const quote = fund.lastQuote;
  const date = typeof quote?.datetime === 'string' && quote.datetime.match(/^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/);
  const fechaValoracion = date ? calendarDate(date[1], date[2], date[3]) : null;
  if (!fechaValoracion || !Number.isFinite(quote?.price) || quote.price <= 0) return null;
  return { fechaValoracion, valorLiquidativo: quote.price,
    variacionDiaria: Number.isFinite(quote.percentChange) ? quote.percentChange : null };
}

export async function fetchAlternativeQuote(isin, divisa, fetchImpl, shutdownSignal) {
  const source = sources.get(isin);
  if (!source || divisa !== 'EUR') return null;
  const signal = AbortSignal.any([shutdownSignal, AbortSignal.timeout(8000)]);
  const unavailable = reason => {
    if (!shutdownSignal.aborted) console.warn(`[Valoraciones] ${source.name} (${isin}): ${reason}`);
    return null;
  };
  try {
    const response = await fetchImpl(source.url, { method: 'GET', redirect: 'manual', headers: { Accept: 'text/html' }, signal });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return unavailable(`HTTP ${response.status}`);
    }
    const valuation = source.parse(await loadHtml(response), isin);
    if (!valuation) return unavailable('no se pudo validar el ISIN, la divisa EUR o la valoración publicada');
    return { isin, divisa, fuente: source.name, ...valuation };
  } catch (error) {
    return unavailable(signal.reason?.name === 'TimeoutError' || error.name === 'TimeoutError'
      ? 'tiempo de espera agotado' : 'falló la consulta HTTP o la lectura de la ficha');
  }
}
