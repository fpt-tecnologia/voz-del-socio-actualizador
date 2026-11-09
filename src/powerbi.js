// Power BI (workspace FPT_WS): lectura por API con la app del actualizador (rol Colaborador, solo consultas DAX).
// Datasets: tablero de gerentes de clubes y seguimiento de ventas por representante.
export const PBI = {
  workspace: '745b6733-bcfa-40f9-ae4e-8ddd1d199a35',
  gerentes: '061c2423-b06d-4613-b789-68409bcef70d', // Managers Dashboards vFull
  ventas: '05748cd1-6bee-48c5-8b90-1ef65befcdc9', // Seg. Ventas
};

let tk = null;
async function token(env) {
  if (tk && tk.exp > Date.now() + 60e3) return tk.v;
  const r = await fetch(`https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`, { method: 'POST',
    body: new URLSearchParams({ client_id: env.GRAPH_CLIENT_ID, client_secret: env.GRAPH_CLIENT_SECRET, scope: 'https://analysis.windows.net/powerbi/api/.default', grant_type: 'client_credentials' }) });
  const j = await r.json(); if (!j.access_token) throw new Error('Power BI: no se obtuvo token (' + (j.error || r.status) + ')');
  tk = { v: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 }; return tk.v;
}

// Ejecuta una consulta DAX y regresa las filas con nombres de columna limpios ("Tabla[Col]" -> "Col")
export async function dax(env, dataset, query, imp = null) {
  const r = await fetch(`https://api.powerbi.com/v1.0/myorg/groups/${PBI.workspace}/datasets/${dataset}/executeQueries`, { method: 'POST',
    headers: { Authorization: 'Bearer ' + (await token(env)), 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: [{ query }], serializerSettings: { includeNulls: true }, ...(imp ? { impersonatedUserName: imp } : {}) }) });
  const t = await r.text(); if (!r.ok) throw new Error(`Power BI ${r.status}: ${t.slice(0, 220)}`);
  const rows = JSON.parse(t).results?.[0]?.tables?.[0]?.rows || [];
  return rows.map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/^.*\[(.*)\]$/, '$1'), v])));
}

// Estructura de los datasets (tablas, columnas y medidas con su fórmula). No trae filas de datos.
export async function esquema(env) {
  const out = { en: new Date().toISOString(), datasets: {} };
  for (const [nombre, ds] of [['gerentes', PBI.gerentes], ['ventas', PBI.ventas]]) {
    const o = { prueba: {} };
    for (const imp of [null, env.PBI_USUARIO || 'jair@fpt.com.mx']) { try { await dax(env, ds, 'EVALUATE ROW("x", 1)', imp); o.prueba[imp || 'app'] = 'ok'; } catch (e) { o.prueba[imp || 'app'] = String(e.message).slice(0, 160); } }
    const impOk = o.prueba.app === 'ok' ? null : Object.keys(o.prueba).find((k) => k !== 'app' && o.prueba[k] === 'ok') || null; o.imp = impOk;
    const daxO = (q) => dax(env, ds, q, impOk);
    const intenta = async (k, qs) => { for (const q of qs) { try { o[k] = await daxO(q); return; } catch (e) { o[k + '_error'] = String(e.message || e).slice(0, 300); } } };
    await intenta('tablas', ['EVALUATE SELECTCOLUMNS(INFO.VIEW.TABLES(), "tabla", [Name], "oculta", [IsHidden], "descripcion", [Description])', 'EVALUATE SELECTCOLUMNS(INFO.TABLES(), "tabla", [Name], "oculta", [IsHidden])']);
    await intenta('columnas', ['EVALUATE SELECTCOLUMNS(INFO.VIEW.COLUMNS(), "tabla", [Table], "columna", [Name], "tipo", [DataType], "oculta", [IsHidden])']);
    await intenta('medidas', ['EVALUATE SELECTCOLUMNS(INFO.VIEW.MEASURES(), "tabla", [Table], "medida", [Name], "formula", [Expression], "carpeta", [DisplayFolder], "formato", [FormatString])', 'EVALUATE SELECTCOLUMNS(INFO.MEASURES(), "medida", [Name], "formula", [Expression])']);
    await intenta('relaciones', ['EVALUATE SELECTCOLUMNS(INFO.VIEW.RELATIONSHIPS(), "relacion", [Relationship])']);
    // Conteo de filas por tabla (sin leer contenido)
    if (Array.isArray(o.tablas)) { o.filas = {}; for (const t of o.tablas.filter((x) => !x.oculta).slice(0, 60)) { try { const [r] = await daxO(`EVALUATE ROW("n", COUNTROWS('${String(t.tabla).replace(/'/g, "''")}'))`); o.filas[t.tabla] = r?.n ?? null; } catch (e) { o.filas[t.tabla] = 'error'; } } }
    out.datasets[nombre] = o;
  }
  return out;
}
