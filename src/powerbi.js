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
  const fs = (j.value || []).filter((f) => f.file && /^kpis_.*\.json$/i.test(f.name)).sort((a, b) => (a.lastModifiedDateTime < b.lastModifiedDateTime ? 1 : -1));
  if (!fs.length) return null;
  const raw = new TextDecoder().decode(await descargar(env, fs[0].id)).replace(/^\uFEFF/, '');
  return { archivo: fs[0].name, modificado: fs[0].lastModifiedDateTime, ...parseKpis(JSON.parse(raw)) };
}

// Archivos en formato largo (tipo, fecha, club, clave, valor) que deja el mismo flujo: extra_*.json (resto del tablero de gerentes) y ventas_*.json (Seg. Ventas)
export async function largoSharePoint(env, prefijo, carpeta = 'Voz del Socio/PowerBI') {
  const s = await sitio(env);
  const j = await g(env, `/sites/${s}/drive/root:/${carpeta.split('/').map(encodeURIComponent).join('/')}:/children?$top=200&$select=id,name,lastModifiedDateTime,file`);
  const re = new RegExp('^' + prefijo + '.*\\.json$', 'i');
  const fs = (j.value || []).filter((f) => f.file && re.test(f.name)).sort((a, b) => (a.lastModifiedDateTime < b.lastModifiedDateTime ? 1 : -1));
  if (!fs.length) return null;
  const raw = JSON.parse(new TextDecoder().decode(await descargar(env, fs[0].id)).replace(/^\uFEFF/, ''));
  const rows = (Array.isArray(raw) ? raw : raw.firstTableRows || []).map(limpia);
  const cache = new Map(); const club = (n) => { if (!cache.has(n)) cache.set(n, clubDe(n)?.club || n); return cache.get(n); };
  return { archivo: fs[0].name, modificado: fs[0].lastModifiedDateTime, filas: rows.filter((r) => r.tipo).map((r) => ({ t: r.tipo, f: String(r.fecha || '').slice(0, 10), c: r.club ? club(r.club) : null, k: r.clave ?? '', v: typeof r.valor === 'number' ? r.valor : r.valor == null ? null : Number(r.valor) })) };
}
const red = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
export function armaExtra(F) {
  const por = (t) => F.filter((r) => r.t === t);
  const mapa = (ts, campos) => { const m = new Map(); for (const [t, campo] of ts) for (const r of por(t)) { const key = r.f + '|' + r.c; if (!m.has(key)) m.set(key, { fecha: r.f, club: r.c, ...campos }); m.get(key)[campo] = red(r.v); } return [...m.values()]; };
  const rot = mapa([['rot_vol_1m', 'r1'], ['rot_vol_12m', 'r12']], { r1: null, r12: null });
  const touch = mapa([['tp_staff', 'staff'], ['tp_entrenador', 'entrenador'], ['tp_limpieza', 'limpieza'], ['tp_areabc', 'areabc'], ['tp_mantenimiento', 'mantenimiento'], ['tp_equipos', 'equipos']], {});
  const razones = por('cancel_razon').map((r) => { const [fa, rz] = String(r.k).split('|'); return { fecha: r.f, club: r.c, tipo: /aut/i.test(fa) ? 'aut' : 'vol', razon: rz || (/aut/i.test(fa) ? 'Automática' : 'Sin razón'), n: r.v }; });
  const cobM = new Map(); for (const r of [...por('cobranza'), ...por('cobranza_meta')]) { const key = r.f + '|' + r.c + '|' + r.k; if (!cobM.has(key)) cobM.set(key, { fecha: r.f, club: r.c, concepto: r.k, tasa: null, meta: null }); cobM.get(key)[r.t === 'cobranza' ? 'tasa' : 'meta'] = red(r.v); }
  const chM = new Map(); for (const r of por('sem_checkins')) { const key = r.f + '|' + r.c; if (!chM.has(key)) chM.set(key, { semana: r.f, club: r.c, bc: 0, cc: 0, otro: 0 }); const o = chM.get(key); o[r.k === 'Black Card' ? 'bc' : r.k === 'Classic Card' ? 'cc' : 'otro'] += r.v || 0; }
  const amen = por('mes_amenidad').filter((r) => r.k && r.k !== 'Checkin').map((r) => ({ fecha: r.f, club: r.c, amenidad: r.k, n: r.v }));
  const hs = por('hora_checkins'); const horas = { fecha: hs[0]?.f || null, filas: hs.map((r) => { const [d, h] = String(r.k).split('|'); return { club: r.c, dia: d, hora: Number(h), prom: red(r.v, 1) }; }) };
  return { rot, touch, razones, cobranza: [...cobM.values()], checkins_sem: [...chM.values()], amenidades: amen, horas };
}
export function armaVentas(F) {
  const semM = new Map(); for (const r of F.filter((x) => x.t.startsWith('sem_'))) { const key = r.f + '|' + r.c; if (!semM.has(key)) semM.set(key, { semana: r.f, club: r.c, total: 0, black: 0, web: 0, rewrite: 0 }); semM.get(key)[r.t.slice(4)] = r.v || 0; }
  // Equipo de ventas por puesto (sin nombres): personas con ventas, ventas y Black por semana, club y puesto
  const catM = new Map(); for (const r of F.filter((x) => x.t.startsWith('rep_'))) { const cat = String(r.k).split('|').pop(); const key = r.f + '|' + r.c + '|' + cat; if (!catM.has(key)) catM.set(key, { semana: r.f, club: r.c, cat, n: 0, total: 0, black: 0 }); const o = catM.get(key); o[r.t === 'rep_total' ? 'total' : r.t === 'rep_black' ? 'black' : 'n'] += r.v || 0; }
  return { sem: [...semM.values()], equipo: [...catM.values()], turno: F.filter((x) => x.t === 'mes_turno').map((r) => ({ fecha: r.f, club: r.c, turno: r.k, n: r.v })),
    fuente: F.filter((x) => x.t === 'mes_fuente').map((r) => ({ fecha: r.f, club: r.c, fuente: r.k, n: r.v })), metas: F.filter((x) => x.t === 'meta_mes').map((r) => ({ fecha: r.f, club: r.c, meta: r.v })) };
}
export function parseKpis(rows) {
  if (!Array.isArray(rows)) rows = rows.firstTableRows || rows.value || rows.results?.[0]?.tables?.[0]?.rows || [];
  const sinMapear = [];
  const out = rows.map(limpia).filter((r) => r.Club_Name && r.socios != null && !/corporat/i.test(r.Club_Name)).map((r) => {
    const fc = String(r.fecha_corte || '').slice(0, 10), fp = String(r.fecha_desempeno || '').slice(0, 10);
    const d = new Date(fc + 'T12:00:00Z'); const diasMes = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); const ritmo = d.getUTCDate() / diasMes;
    const m = clubDe(r.Club_Name); if (!m) sinMapear.push(r.Club_Name);
    const vAv = r.ventas_meta_mes ? r.ventas_mtd / r.ventas_meta_mes : null, cUso = r.cancel_vol_meta_mes ? r.cancel_vol_mtd / r.cancel_vol_meta_mes : null;
    return { fecha_corte: fc, fecha_desempeno: fp || null, club: m?.club || r.Club_Name, club_pbi: r.Club_Name, region: m?.region || regionPbi(r.region_pbi), region_pbi: r.region_pbi || null, ritmo_mes: r4(ritmo),
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
  // Los cortes de domingo (a mitad de mes) no traen las metas de cancelación ni de Black: se toman del corte más reciente del mismo mes
  const ult = new Map(); for (const r of out) { const k = r.club + '|' + r.fecha_corte.slice(0, 7); const u = ult.get(k); if (!u || r.fecha_corte > u.fecha_corte) ult.set(k, r); }
  for (const r of out) { const u = ult.get(r.club + '|' + r.fecha_corte.slice(0, 7)); if (!u || u === r) continue;
    for (const f of ['cancel_vol_meta_mes', 'cancel_aut_meta_mes', 'black_meta_tablero', 'black_meta', 'nps_meta']) if (r[f] == null && u[f] != null) r[f] = u[f];
    const cUso = r.cancel_vol_meta_mes ? r.cancel_vol_mtd / r.cancel_vol_meta_mes : null; r.cancel_uso_meta = r4(cUso); r.cancel_vs_ritmo = cUso != null && r.ritmo_mes ? r4(cUso / r.ritmo_mes) : null; }
  return { filas: out, sin_mapear: [...new Set(sinMapear)] };
}
// Región según Power BI (Aperturas): R1..R5 -> Región N; JEG se reporta dentro de Región 3
export function regionPbi(v) { const s = String(v || '').trim().toUpperCase(); if (s === 'JEG') return 'Región 3'; const m = s.match(/^R(\d)$/); return m ? 'Región ' + m[1] : null; }

// Contador_Socios: movimientos diarios agrupados por semana y perfil actual de los socios activos
export function armaSocios(F) {
  const m = new Map(); const map = { sem_ventas: 'ventas', sem_rewrites: 'rewrites', sem_cancel_vol: 'cancel_vol', sem_cancel_aut: 'cancel_aut', sem_socios: 'socios' };
  for (const r of F.filter((x) => map[x.t])) { const key = r.f + '|' + r.c; if (!m.has(key)) m.set(key, { semana: r.f, club: r.c, ventas: 0, rewrites: 0, cancel_vol: 0, cancel_aut: 0, socios: null }); m.get(key)[map[r.t]] = r.v; }
  const perfil = F.filter((x) => x.t === 'perfil').map((r) => { const [tipo, edad, genero] = String(r.k).split('|'); return { club: r.c, tipo, edad, genero, n: r.v }; });
  return { fecha: F.find((x) => x.t === 'perfil')?.f || null, sem: [...m.values()], perfil };
}
// PBI_Product Sales: venta de producto por mes, club y categoría; visitas por socio por semana
export function armaProducto(F) {
  const m = new Map(); for (const r of F.filter((x) => x.t.startsWith('prod_'))) { const key = r.f + '|' + r.c + '|' + r.k; if (!m.has(key)) m.set(key, { fecha: r.f, club: r.c, categoria: r.k, unidades: 0, monto: 0 }); m.get(key)[r.t === 'prod_unidades' ? 'unidades' : 'monto'] = red(r.v, 0); }
  return { ventas: [...m.values()], visitas: F.filter((x) => x.t === 'sem_visitas_socio').map((r) => ({ semana: r.f, club: r.c, visitas: red(r.v, 2) })) };
}
// Vacantes_CH: solo conteos por club, puesto, estatus y tipo (sin candidatos ni reclutadores)
export function armaVacantes(F) {
  const m = new Map(); for (const r of F.filter((x) => x.t.startsWith('vac_'))) { const [puesto, estatus, tipo] = String(r.k).split('|'); const key = r.c + '|' + r.k; if (!m.has(key)) m.set(key, { club: r.c, puesto, estatus, tipo, n: 0, dias: null }); m.get(key)[r.t === 'vac_n' ? 'n' : 'dias'] = r.t === 'vac_n' ? r.v : red(r.v, 1); }
  return { fecha: F[0]?.f || null, filas: [...m.values()] };
}
// Encuesta Perfil del Socio (por región y año) y Encuesta de Satisfacción del personal 2025 (por club con 5 respuestas o más)
export function armaPerfil(F) {
  const preg = Object.fromEntries(F.filter((x) => x.t === 'pds_pregunta').map((r) => { const [v, p] = String(r.k).split('|'); return [v, p]; }));
  return { preguntas: preg, base: F.filter((x) => x.t === 'pds_base').map((r) => ({ anio: r.f, region: r.c, n: r.v })),
    resp: F.filter((x) => x.t === 'pds_resp').map((r) => { const i = String(r.k).indexOf('|'); return { anio: r.f, region: r.c, pregunta: String(r.k).slice(0, i), respuesta: String(r.k).slice(i + 1), n: r.v }; }) };
}
export function armaSatisf(F) {
  return { grupos: F.filter((x) => x.t === 'sat_grupo').map((r) => ({ club: r.c, grupo: r.k, prom: red(r.v, 2) })), enps: F.filter((x) => x.t === 'sat_enps').map((r) => ({ club: r.c, clase: r.k, n: r.v })) };
}
