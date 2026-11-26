type Envelope = {
  status?: string;
  message?: string;
  result?: { structuredContent?: unknown; content?: { type: string; text?: string }[] };
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function query<T = any>(endpoint: string, label: string, signal?: AbortSignal, data?: object): Promise<T> {
  const response = await fetch(`/api/${endpoint}`, {
    method: 'POST', signal, ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {})
  });
  const body: Envelope = await response.json();
  signal?.throwIfAborted();
  if (!response.ok || (body.status && body.status !== 'success')) {
    throw new ApiError(body.message || `${label}: HTTP ${response.status}`, response.status);
  }
  if (body.result?.structuredContent) return body.result.structuredContent as T;
  for (const entry of body.result?.content || []) if (entry.type === 'text' && entry.text) {
    try { return JSON.parse(entry.text) as T; } catch { /* La respuesta puede incluir texto adicional. */ }
  }
  return body as T;
}

export const money = (value: number, currency = 'EUR', signed = false) => new Intl.NumberFormat('es-ES', {
  style: 'currency', currency, signDisplay: signed ? 'exceptZero' : 'auto'
}).format(value);
export const madridToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
export const displayDate = (date: string) => date.split('-').reverse().join('/');

export async function submitOnce(endpoint: string, label: string, data: object, keyField: string) {
  const draft = `mi-balance:${endpoint}:${JSON.stringify(data)}`;
  const key = sessionStorage.getItem(draft) ?? crypto.randomUUID();
  sessionStorage.setItem(draft, key);
  try {
    const result = await query(endpoint, label, undefined, { ...data, [keyField]: key });
    sessionStorage.removeItem(draft);
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) sessionStorage.removeItem(draft);
    throw error;
  }
}
