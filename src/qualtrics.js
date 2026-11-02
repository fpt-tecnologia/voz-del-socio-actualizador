// NPS semanal desde la API de Qualtrics (port de weekly_pipeline.py): NPS de red, ranking completo de clubes,
// top 5 / bottom 5 con movimiento vs la semana previa y escaneo de palabras clave de riesgo sobre el 100% de las respuestas.
import { unzipSync, strFromU8 } from 'fflate';

const MIN_SAMPLE = 15; // respuestas mínimas en la semana para entrar al ranking
const SCORE_KEY = 'QID2', COMMENT_KEY = 'QID3_TEXT', CLUB_KEY = 'Club Name';

async function q(env, method, path, body) {
  const base = `https://${env.QUALTRICS_DATACENTER || 'iad1'}.qualtrics.com/API/v3`;
  const r = await fetch(base + path, { method, headers: { 'X-API-TOKEN': env.QUALTRICS_API_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Qualtrics ${r.status} en ${path.split('/').slice(-2).join('/')}: ${(await r.text()).slice(0, 160)}`);
  return r;
}

export async function exportar(env, desde, hasta) {
  const sid = env.QUALTRICS_SURVEY_ID;
  const ini = await (await q(env, 'POST', `/surveys/${sid}/export-responses`, { format: 'json', startDate: desde, endDate: hasta })).json();
  const pid = ini.result.progressId; let fileId = null;
  for (let i = 0; i < 90 && !fileId; i++) {
    await new Promise((ok) => setTimeout(ok, 2000));
    const p = await (await q(env, 'GET', `/surveys/${sid}/export-responses/${pid}`)).json();
    if (p.result.status === 'complete') fileId = p.result.fileId;
    else if (p.result.status === 'failed') throw new Error('Qualtrics: la exportación falló');
  }
  if (!fileId) throw new Error('Qualtrics: la exportación tardó demasiado');
  const zip = new Uint8Array(await (await q(env, 'GET', `/surveys/${sid}/export-responses/${fileId}/file`)).arrayBuffer());
  const files = unzipSync(zip); const name = Object.keys(files).find((n) => n.endsWith('.json'));
  return JSON.parse(strFromU8(files[name])).responses || [];
}

function tabla(resps) {
  const agg = new Map();
  for (const r of resps) {
    const v = r.values || {}; const club = v[CLUB_KEY]; const s = v[SCORE_KEY];
    if (club == null || s == null || s === '') continue;
    const a = agg.get(club) || { club, n: 0, det: 0, pas: 0, prom: 0 }; a.n++;
    if (Number(s) <= 6) a.det++; else if (Number(s) <= 8) a.pas++; else a.prom++;
    agg.set(club, a);
  }
  return [...agg.values()].map((a) => ({ ...a, nps: Math.round((a.prom / a.n - a.det / a.n) * 100) })).sort((a, b) => b.nps - a.nps);
}

const RIESGO = [
  ['Seguridad / Robo', /me robaron|robo (en|de) mi|abrieron (mi|el) (candado|locker|casillero)|forzaron.*candado|rompieron.*candado|robos? en (el|los) (vestidor|locker|casillero|ba[ñn]o)|le robaron|robaron.*candado|denunci[ea]|polic[ií]a|ministerio p[uú]blico\b/i],
  ['Salud / Higiene grave', /plaga|cucarach|\brata\b|\bratas\b|fuga de gas|intoxica|electrocut|contagi/i],
  ['Lesión / Accidente', /se desmay|desmayo|convuls|fractur|se cay[oó] |ambulanc|hospital(?!idad)|consumo de drogas|drogad[oa]/i],
  ['Acoso / Abuso', /acos[oa](ndo|ba|n)?|abus[oa] (sexual|de (su|un) puesto)|discrimin|amenaz|golpiza|pelea f[ií]sica|se burlaron|burl[oó] de|menor de edad/i],
  ['Legal / Cobros', /sigu(e|en) cobrando|no me dejan cancelar|cancel[ea]r.*(no me dejan|complicado|dif[ií]cil)|profeco|niegan.*cancelaci[oó]n|cobr[ao]ndo.*cancel/i],
];
const TEMA_DE = { 'Seguridad / Robo': 'Seguridad y robo', 'Salud / Higiene grave': 'Limpieza', 'Lesión / Accidente': 'Mantenimiento y equipos', 'Acoso / Abuso': 'Acoso o discriminación', 'Legal / Cobros': 'Cobros y cancelación' };

function riesgos(resps) {
  const out = [];
  for (const r of resps) {
    const v = r.values || {}; const c = String(v[COMMENT_KEY] || '').trim(); if (!c) continue;
    const hit = RIESGO.find(([, re]) => re.test(c));
    if (hit) out.push({ club: v[CLUB_KEY] || '', categoria: hit[0], calificacion: v[SCORE_KEY] ?? null, texto: c, fecha: String(v.recordedDate || '').slice(0, 10) });
  }
  return out;
}

// finISO = fin de la ventana (lunes 08:00 CDMX). Devuelve filas listas para el dashboard.
export async function npsSemanal(env, finISO) {
  const fin = new Date(finISO), ini = new Date(fin - 7 * 864e5), ini2 = new Date(fin - 14 * 864e5);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const cur = await exportar(env, iso(ini), iso(fin));
  const prev = await exportar(env, iso(ini2), iso(ini));
  const tc = tabla(cur), tp = tabla(prev);
  const el = tc.filter((c) => c.n >= MIN_SAMPLE), elp = tp.filter((c) => c.n >= MIN_SAMPLE);
  const rankPrev = new Map(elp.map((c, i) => [c.club, i + 1]));
  const dia = (d) => new Date(d - 6 * 3600e3).toISOString().slice(0, 10); // fecha en CDMX (UTC-6)
  const periodo_fin = dia(fin), periodo_inicio = dia(ini);
  const N = tc.reduce((s, c) => s + c.n, 0), P = tc.reduce((s, c) => s + c.prom, 0), D = tc.reduce((s, c) => s + c.det, 0);
  const hall = riesgos(cur);
  const fuente_doc = `API de Qualtrics · semana ${periodo_inicio} a ${periodo_fin}`;
  const ranking = el.map((c, i) => ({ periodo_inicio, periodo_fin, club_texto: c.club, nps: c.nps, n: c.n, promotores: c.prom, pasivos: c.pas, detractores: c.det, rank: i + 1, rank_previo: rankPrev.get(c.club) ?? null, total_clubes: el.length, fuente_doc }));
  const nps_clubes = [...ranking.slice(0, 5).map((r) => ({ ...r, grupo: 'top' })), ...(el.length >= 5 ? ranking.slice(-5).map((r) => ({ ...r, grupo: 'bottom' })) : [])]
    .map(({ periodo_fin: pf, club_texto, nps, n, rank, rank_previo, grupo }) => ({ periodo_fin: pf, club_texto, nps, n, rank, rank_previo, grupo, fuente_doc }));
  const nps_semanal = [{ periodo_inicio, periodo_fin, nps: N ? Math.round((P / N - D / N) * 100) : null, respuestas: N, promotores: P, pasivos: N - P - D, detractores: D, clubes_con_muestra: el.length, hallazgos_riesgo: hall.length, fuente_doc }];
  const comentarios = hall.map((h) => ({ fecha: h.fecha || periodo_fin, periodo_inicio, periodo_fin, fuente: 'NPS Qualtrics', marca: 'Planet Fitness', club_texto: h.club, tema: TEMA_DE[h.categoria] || 'Otro',
    sentimiento: 'negativo', texto: h.texto.slice(0, 280), canal: 'Encuesta', calificacion_nps: h.calificacion == null ? null : Number(h.calificacion), categoria_riesgo_fuente: h.categoria, url: null, fuente_doc }));
  return { nps_semanal, nps_clubes, comentarios, ranking, resumen: { periodo_inicio, periodo_fin, nps: nps_semanal[0].nps, respuestas: N, clubes: el.length, hallazgos: hall.length } };
}
