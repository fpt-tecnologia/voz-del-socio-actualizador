// Acceso al bucket R2 "fpt-voc" por la API REST de Cloudflare, con la misma interfaz que el binding del Worker.
const base = () => `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/r2/buckets/${process.env.R2_BUCKET || 'fpt-voc'}`;
const H = () => ({ Authorization: 'Bearer ' + process.env.CF_TOKEN });
const enc = (k) => k.split('/').map(encodeURIComponent).join('/');
async function req(path, opts = {}) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(base() + path, { ...opts, headers: { ...H(), ...(opts.headers || {}) } });
    if (r.status >= 500) { await new Promise((ok) => setTimeout(ok, 2000 * (i + 1))); continue; }
    return r;
  }
  throw new Error('R2 no respondió: ' + path);
}
export const DATOS = {
  async get(key) {
    const r = await req('/objects/' + enc(key)); if (r.status === 404) return null;
    if (!r.ok) throw new Error(`R2 get ${key}: ${r.status}`);
    const buf = await r.arrayBuffer();
    return { arrayBuffer: async () => buf, json: async () => JSON.parse(new TextDecoder().decode(buf)), text: async () => new TextDecoder().decode(buf) };
  },
  async put(key, body, opts = {}) {
    const r = await req('/objects/' + enc(key), { method: 'PUT', headers: { 'Content-Type': opts.httpMetadata?.contentType || 'application/octet-stream' }, body });
    const j = await r.json().catch(() => ({})); if (!r.ok || j.success === false) throw new Error(`R2 put ${key}: ${r.status} ${JSON.stringify(j.errors || '')}`);
  },
  async delete(key) { await req('/objects/' + enc(key), { method: 'DELETE' }); },
  async list({ prefix = '' } = {}) {
    const objects = []; let cursor = null;
    do { const r = await req(`/objects?prefix=${encodeURIComponent(prefix)}&per_page=1000${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`); const j = await r.json();
      for (const o of j.result || []) objects.push({ key: o.key, size: o.size }); cursor = j.result_info?.cursor || null; } while (cursor);
    return { objects };
  },
};
