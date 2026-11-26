import { calendarDate, loadHtml, localizedNumber, localizedPercent } from './quote-format.js';

const ficha = 'https://www.quefondos.com/m/es/fondos/ficha/index.html';
function readQuote($, isin) {
  const block = $('h4').filter((_, heading) => $(heading).text().trim().toLowerCase() === 'última valoración').first().parent();
  const fields = new Map();
  block.find('p').each((_, paragraph) => {
    const label = $(paragraph).find('span.floatleft').first().text().trim().replace(/\s*:\s*$/, '').replace(/\s+/g, ' ').toLowerCase();
    const value = $(paragraph).find('span.floatright').first().text().trim();
    if (label && value) fields.set(label, value);
  });

  const nav = fields.get('valor liquidativo')?.match(/^(.+?)\s+([A-Z]{3})$/);
  const date = fields.get('fecha')?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!nav || !date) return null;
  const [, day, month, year] = date;
  const fechaValoracion = calendarDate(year, month, day);
  const valorLiquidativo = localizedNumber(nav[1], 'es');
  if (!fechaValoracion || valorLiquidativo === null || valorLiquidativo <= 0) return null;
  return { isin, valorLiquidativo, divisa: nav[2], fechaValoracion, fuente: 'Quefondos',
    variacionDiaria: localizedPercent(fields.get('1 día'), 'es') };
}

export async function fetchQuefondos(isin, fetchImpl, shutdownSignal) {
  const url = new URL(ficha);
  url.searchParams.set('isin', isin);
  try {
    const response = await fetchImpl(url.href, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.any([shutdownSignal, AbortSignal.timeout(12000)])
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    return readQuote(await loadHtml(response), isin);
  } catch {
    return null;
  }
}
