// Microsoft Graph con credenciales de aplicación (solo lectura): correo de un buzón y archivos de SharePoint.
let tok = null, tokExp = 0;
export async function token(env) {
  if (tok && Date.now() < tokExp - 60e3) return tok;
  const r = await fetch(`https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GRAPH_CLIENT_ID, client_secret: env.GRAPH_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Microsoft Graph no dio acceso: ' + (j.error_description || j.error || r.status).toString().slice(0, 200));
  tok = j.access_token; tokExp = Date.now() + j.expires_in * 1000; return tok;
}
export async function g(env, path, opts = {}) {
  const url = path.startsWith('https://') ? path : 'https://graph.microsoft.com/v1.0' + path;
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + (await token(env)), ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Graph ${r.status} en ${path.slice(0, 80)}: ${(await r.text()).slice(0, 200)}`);
  return opts.raw ? r : r.json();
}

// Correos del buzón recibidos después de `desde` (ISO) que coinciden con la búsqueda
export async function buscarCorreos(env, { buscar, de, desde, max = 15 }) {
  const mbox = encodeURIComponent(env.MAILBOX);
  const q = new URLSearchParams({ $search: `"${buscar}"`, $top: String(max), $select: 'id,subject,from,receivedDateTime,hasAttachments,webLink,body' });
  const j = await g(env, `/users/${mbox}/messages?${q}`, { headers: { ConsistencyLevel: 'eventual' } });
  return (j.value || []).filter((m) => (!desde || m.receivedDateTime > desde) && (!de || (m.from?.emailAddress?.address || '').toLowerCase() === de.toLowerCase()))
    .sort((a, b) => (a.receivedDateTime < b.receivedDateTime ? -1 : 1));
}
export async function adjuntos(env, msgId) {
  const mbox = encodeURIComponent(env.MAILBOX);
  const j = await g(env, `/users/${mbox}/messages/${msgId}/attachments?$select=id,name,contentType,size,isInline`);
  const out = [];
  for (const a of j.value || []) {
    if (a.isInline || a.size > 25e6) continue;
    const r = await g(env, `/users/${mbox}/messages/${msgId}/attachments/${a.id}/$value`, { raw: true });
    out.push({ nombre: a.name, bytes: await r.arrayBuffer() });
  }
  return out;
}
export const cuerpoTexto = (m) => (m.body?.content || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// SharePoint: sitio por ruta, búsqueda de archivos y descarga
let sitioId = null;
export async function sitio(env) {
  if (sitioId) return sitioId;
  const j = await g(env, `/sites/${env.SP_HOST}:/sites/${env.SP_SITE}`); sitioId = j.id; return sitioId;
}
export async function buscarArchivos(env, texto) {
  const s = await sitio(env);
  const j = await g(env, `/sites/${s}/drive/root/search(q='${encodeURIComponent(texto.replace(/'/g, "''"))}')?$top=50&$select=id,name,webUrl,lastModifiedDateTime,file,parentReference`);
  return (j.value || []).filter((f) => f.file);
}
export async function descargar(env, itemId) {
  const s = await sitio(env);
  const r = await g(env, `/sites/${s}/drive/items/${itemId}/content`, { raw: true });
  return r.arrayBuffer();
}
