import { sitio, g, descargar } from './graph.js';
import { CLUBES } from './catalogo.js';
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

// ---- KPIs operativos por club desde SharePoint ----
// Un flujo de Power Automate (con la cuenta de Jair, miembro de FPT_WS) corre la consulta DAX del tablero de gerentes
// y deja un JSON en SharePoint (MARKETINGTEAM > Documentos > Voz del Socio > PowerBI). Aquí se toma el más reciente.
const sinAc = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export function clubDe(nombrePbi) {
  const n = sinAc(nombrePbi); if (!n) return null;
  for (const [club, [region]] of Object.entries(CLUBES)) if (sinAc(club) === n) return { club, region };
  for (const [club, [region, , kws]] of Object.entries(CLUBES)) if ((kws || []).some((k) => n.includes(sinAc(k))) || (n.length >= 4 && sinAc(club).includes(n))) return { club, region };
  return null;
}
const limpia = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/^.*\[(.*)\]$/, '$1').replace(/^\[|\]$/g, ''), v]));
const r4 = (v) => (v == null || typeof v !== 'number' || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
export async function kpisSharePoint(env, carpeta = 'Voz del Socio/PowerBI') {
  const s = await sitio(env);
  const j = await g(env, `/sites/${s}/drive/root:/${carpeta.split('/').map(encodeURIComponent).join('/')}:/children?$top=200&$select=id,name,lastModifiedDateTime,file`);
  const fs = (j.value || []).filter((f) => f.file && /\.json$/i.test(f.name)).sort((a, b) => (a.lastModifiedDateTime < b.lastModifiedDateTime ? 1 : -1));
  if (!fs.length) return null;
  const raw = new TextDecoder().decode(await descargar(env, fs[0].id)).replace(/^\uFEFF/, '');
  return { archivo: fs[0].name, modificado: fs[0].lastModifiedDateTime, ...parseKpis(JSON.parse(raw)) };
}
export function parseKpis(rows) {
  if (!Array.isArray(rows)) rows = rows.firstTableRows || rows.value || rows.results?.[0]?.tables?.[0]?.rows || [];
  const sinMapear = [];
  const out = rows.map(limpia).filter((r) => r.Club_Name && r.socios != null && !/corporat/i.test(r.Club_Name)).map((r) => {
    const fc = String(r.fecha_corte || '').slice(0, 10), fp = String(r.fecha_desempeno || '').slice(0, 10);
    const d = new Date(fc + 'T12:00:00Z'); const diasMes = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); const ritmo = d.getUTCDate() / diasMes;
    const m = clubDe(r.Club_Name); if (!m) sinMapear.push(r.Club_Name);
    const vAv = r.ventas_meta_mes ? r.ventas_mtd / r.ventas_meta_mes : null, cUso = r.cancel_vol_meta_mes ? r.cancel_vol_mtd / r.cancel_vol_meta_mes : null;
    return { fecha_corte: fc, fecha_desempeno: fp || null, club: m?.club || r.Club_Name, club_pbi: r.Club_Name, region: m?.region || null, ritmo_mes: r4(ritmo),
      socios: r.socios, socios_avance_meta: r4(r.socios_avance_meta),
      ventas_mtd: r.ventas_mtd, ventas_meta_mes: r4(r.ventas_meta_mes), ventas_avance: r4(vAv), ventas_vs_ritmo: vAv != null && ritmo ? r4(vAv / ritmo) : null,
      black_mtd: r.black_mtd, black_pct: r.ventas_mtd ? r4(r.black_mtd / r.ventas_mtd) : null, black_meta: r4(r.black_meta),
      cancel_vol_mtd: r.cancel_vol_mtd, cancel_vol_meta_mes: r4(r.cancel_vol_meta_mes), cancel_uso_meta: r4(cUso), cancel_vs_ritmo: cUso != null && ritmo ? r4(cUso / ritmo) : null, cancel_vol_pct: r4(r.cancel_vol_pct),
      rot_vol_12m: r4(r.rot_vol_12m), rot_vol_meta: r4(r.rot_vol_meta), rot_1m: r4(r.rot_1m), desempeno: r.desempeno == null || r.desempeno < 1 ? null : Math.round(r.desempeno * 10) / 10,
      // Indicadores del Estatus Histórico del tablero (cierre de mes)
      black_pct_tablero: r4(r.black_pct_tablero), black_meta_tablero: r4(r.black_meta_tablero), conversion: r4(r.conversion),
      cancel_aut_mtd: r.cancel_aut_mtd ?? null, cancel_aut_meta_mes: r4(r.cancel_aut_meta_mes), cancel_aut_pct: r4(r.cancel_aut_pct),
      nps_mes: r.nps_mes == null ? null : Math.round(r.nps_mes * 10) / 10, nps_3m: r.nps_3m == null ? null : Math.round(r.nps_3m * 10) / 10, nps_meta: r.nps_meta == null ? null : Math.round(r.nps_meta * 10) / 10 };
  });
  return { filas: out, sin_mapear: [...new Set(sinMapear)] };
}
