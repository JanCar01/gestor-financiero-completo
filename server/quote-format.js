import { loadBuffer } from 'cheerio';

export const isinValido = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
export const divisaValida = /^[A-Z]{3}$/;

export function calendarDate(year, month, day) {
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

const numberFormats = {
  es: /^[+−-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/,
  en: /^[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/
};

export function localizedNumber(text, locale) {
  if (!text || !numberFormats[locale].test(text.trim())) return null;
  const normalized = locale === 'es' ? text.replaceAll('.', '').replace(',', '.') : text.replaceAll(',', '');
  const value = Number(normalized.replace('−', '-'));
  return Number.isFinite(value) ? value : null;
}

export function localizedPercent(text, locale) {
  const value = text?.trim();
  return value?.endsWith('%') ? localizedNumber(value.slice(0, -1), locale) : null;
}

export async function loadHtml(response) {
  const charset = response.headers.get('content-type')?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  return loadBuffer(Buffer.from(await response.arrayBuffer()), { encoding: { transportLayerEncodingLabel: charset } });
}
