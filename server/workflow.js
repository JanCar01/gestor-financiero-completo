import { NotionError } from './notion.js';
import { calendarDate } from './quote-format.js';

export class WorkflowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function canonicalId(value) {
  const compact = typeof value === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)
    ? value.toLowerCase().replaceAll('-', '') : '';
  return compact ? compact.replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/, '$1-$2-$3-$4-$5') : null;
}

export function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return calendarDate(...value.split('-'));
}

export const inDatabase = (page, id) => page.parent?.database_id === id ||
  (canonicalId(id) !== null && canonicalId(page.parent?.database_id) === canonicalId(id));

export const madridToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
export const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function createSerializer() {
  const pending = new Map();
  return async (keys, work) => {
    const task = Promise.all(keys.map(key => pending.get(key))).then(work);
    const marker = task.catch(() => {});
    for (const key of keys) pending.set(key, marker);
    try { return await task; }
    finally {
      for (const key of keys) if (pending.get(key) === marker) pending.delete(key);
    }
  };
}

const uncertainError = () => new WorkflowError(503, 'Notion no confirmó la escritura. Reintenta para comprobar si la guardó.');

export function createWriteGuard() {
  const unresolved = new Map();
  function clear(attempt) {
    for (const key of attempt.scopes) if (unresolved.get(key) === attempt) unresolved.delete(key);
  }

  return async (key, scopes, find, write, prepare) => {
    for (const scope of scopes) {
      const attempt = unresolved.get(scope);
      if (!attempt) continue;
      const saved = await attempt.find().catch(() => null);
      if (!saved) throw uncertainError();
      clear(attempt);
      if (attempt.key === key) return saved;
    }
    const existing = await find();
    if (existing) return existing;
    const prepared = await prepare?.();
    try { return await write(prepared); }
    catch (error) {
      if (error instanceof WorkflowError || (error instanceof NotionError && error.status < 500 && ![408, 409].includes(error.status))) throw error;
      const attempt = { key, scopes, find };
      scopes.forEach(scope => unresolved.set(scope, attempt));
      const saved = await find().catch(() => null);
      if (!saved) throw uncertainError();
      clear(attempt);
      return saved;
    }
  };
}
