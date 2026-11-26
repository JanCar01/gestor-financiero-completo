import { setTimeout as delay } from 'node:timers/promises';

export class NotionError extends Error {
  constructor(status) {
    const hint = status === 401 ? 'Comprueba NOTION_TOKEN.' : [403, 404].includes(status)
      ? 'Comprueba el ID y los permisos de la integración.' : 'Vuelve a intentarlo más tarde.';
    super(`Notion (HTTP ${status}). ${hint}`);
    this.status = status;
  }
}

export function createNotionClient({ token, fetchImpl, shutdownSignal }) {
  async function request(method, endpoint, body) {
    const signal = AbortSignal.any([shutdownSignal, AbortSignal.timeout(30000)]);
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(`https://api.notion.com/v1/${endpoint}`, {
        method, signal,
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      if (response.ok) return response.json();
      void response.body?.cancel().catch(() => {});
      if (response.status !== 429 || attempt >= 2) throw new NotionError(response.status);
      await delay((Number(response.headers.get('retry-after')) || 1) * 1000, undefined, { signal });
    }
  }

  return {
    async query(id, parameters = {}) {
      const results = [];
      let cursor;
      do {
        const data = await request('POST', `databases/${id}/query`, { ...parameters, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
        results.push(...data.results);
        cursor = data.has_more ? data.next_cursor : undefined;
        if (results.length > 10000) throw new Error('Se ha superado el límite de 10.000 registros.');
      } while (cursor);
      return results;
    },
    database: id => request('GET', `databases/${id}`),
    page: id => request('GET', `pages/${id}`),
    create: (id, properties) => request('POST', 'pages', { parent: { database_id: id }, properties }),
    update: (id, properties) => request('PATCH', `pages/${id}`, { properties }),
    archive: id => request('PATCH', `pages/${id}`, { archived: true })
  };
}

export function plain(prop) {
  if (prop?.type === 'title' || prop?.type === 'rich_text') return (prop[prop.type] || []).map(t => t.plain_text ?? t.text?.content ?? '').join('');
  if (prop?.type === 'select') return prop.select?.name || '';
  if (prop?.type === 'status') return prop.status?.name || '';
  if (prop?.type === 'formula') return String(prop.formula?.string ?? prop.formula?.number ?? '');
  return '';
}

export function numeric(prop) {
  const value = prop?.type === 'formula' ? prop.formula?.number : prop?.type === 'number' ? prop.number : undefined;
  return value == null ? NaN : Number(value);
}

export function property(props, names) {
  return names.map(name => props[name]).find(Boolean);
}

const text = content => [{ type: 'text', text: { content } }];
export const title = content => ({ title: text(content) });
export const richText = content => ({ rich_text: text(content) });
export const dateProperty = start => ({ date: { start } });
export const relation = id => ({ relation: [{ id }] });
