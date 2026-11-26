import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchAlternativeQuote } from './alternative-quotes.js';
import { fetchQuefondos } from './quefondos.js';
import { calendarDate } from './quote-format.js';

async function readSavedQuote(file, isin, divisa) {
  try {
    const quote = JSON.parse(await readFile(file, 'utf8'));
    if (quote?.isin === isin && quote.divisa === divisa && ['Quefondos', 'Vanguard España', 'Finect'].includes(quote.fuente) &&
        Number.isFinite(quote.valorLiquidativo) && quote.valorLiquidativo > 0 &&
        typeof quote.fechaValoracion === 'string' && calendarDate(...quote.fechaValoracion.split('-')) === quote.fechaValoracion &&
        (quote.variacionDiaria === null || Number.isFinite(quote.variacionDiaria))) return quote;
  } catch { /* La consulta sigue disponible si aún no hay caché o no puede leerse. */ }
  return null;
}

async function saveQuote(file, quote) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temp, JSON.stringify(quote));
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export function createQuoteLookup({ fetchImpl, signal, cacheDirectory }) {
  const latest = new Map();
  const pending = new Map();

  async function lookup(isin, divisa, key) {
    const [quefondos, secondary] = await Promise.all([
      fetchQuefondos(isin, fetchImpl, signal),
      fetchAlternativeQuote(isin, divisa, fetchImpl, signal)
    ]);
    const primary = quefondos?.divisa === divisa ? quefondos : null;
    const selected = secondary && (!primary || secondary.fechaValoracion > primary.fechaValoracion) ? secondary : primary;

    const file = cacheDirectory && path.join(cacheDirectory, `${isin}-${divisa}.json`);
    const saved = latest.get(key) ?? (file ? await readSavedQuote(file, isin, divisa) : null);
    if (saved) latest.set(key, saved);
    if (selected && (!saved || selected.fechaValoracion >= saved.fechaValoracion) && JSON.stringify(selected) !== JSON.stringify(saved)) {
      latest.set(key, selected);
      if (file) await saveQuote(file, selected);
    }
    return { valoracion: selected ?? saved, valoracionGuardada: !selected && Boolean(saved) };
  }

  return (isin, divisa) => {
    const key = `${isin}:${divisa}`;
    if (!pending.has(key)) pending.set(key, lookup(isin, divisa, key).finally(() => pending.delete(key)));
    return pending.get(key);
  };
}
