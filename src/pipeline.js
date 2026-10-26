// Port fiel de pipeline.py: fusiona secciones nuevas con el estado, normaliza clubes/regiones
// y recalcula la categoría de riesgo de todos los comentarios. Produce los mismos ids que la versión Python.
import { REGIONAL, CLUBES, GBP_CID, SP_WEB, TEMAS, SOCIO_KW, OPER_KW } from './catalogo.js';

export const SECCIONES = ['comentarios', 'nps_semanal', 'nps_clubes', 'sl_semanal', 'sl_canales', 'axol_semanal', 'mensual', 'insights'];

const pyStr = (p) => (p === null || p === undefined ? 'None' : typeof p === 'boolean' ? (p ? 'True' : 'False') : String(p));

export async function sha1hex(s) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const rid = async (...parts) => (await sha1hex(parts.map(pyStr).join('|'))).slice(0, 12);

export function norm(s) {
  return (s || '').normalize('NFD').replace(/[^\x00-\x7F]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function matchClub(texto, marca) {
  if (marca !== 'Planet Fitness') return '';
  const t = norm(texto);
  if (!t || t.startsWith('solicitud') || t.includes('proxima apertura') || t.includes('no especificado')) return '';
  let best = '', pos = 1e9;
  for (const [club, [, , alias]] of Object.entries(CLUBES)) {
    for (const a of alias) { const i = t.indexOf(a); if (i !== -1 && i < pos) { best = club; pos = i; } }
  }
  return best;
}

export function semanaDe(fin) {
  const d = new Date(fin + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
  const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd);
  return d.toISOString().slice(0, 10);
}

function clubPorUrl(url) {
  const m = (url || '').match(/(0x[0-9a-f]+:0x[0-9a-f]+)/);
  return m ? GBP_CID[m[1]] || '' : '';
}

export function reporteUrl(c) {
  if (c.reporte_url) return c.reporte_url.replace(/ /g, '%20');
  const u = (c.fuente_uri || '').split(' | ')[0].trim();
  let m = u.match(/^mail:\/\/\/messages\/([^/?]+)/);
  if (m) return 'https://outlook.office365.com/owa/?ItemID=' + m[1] + '&exvsurl=1&viewmodel=ReadMessageItem';
  m = u.match(/^file:\/\/\/[^/]+\/([A-Z0-9]+)$/);
  if (m && SP_WEB[m[1]]) return SP_WEB[m[1]].replace(/ /g, '%20');
  if (u.startsWith('https://')) return u;
  return '';
}

function categoria(c, rec) {
  if (c.sentimiento === 'positivo') return 'Elogio';
  if (c.sentimiento === 'neutral') return 'Consulta / neutral';
  const t = norm(c.texto) + ' ' + norm(c.categoria_riesgo_fuente || '');
  if (['Seguridad y robo', 'Acoso o discriminación'].includes(c.tema) || SOCIO_KW.some((k) => t.includes(k))) return 'Riesgo para el socio';
  if (['Cobros y cancelación', 'Agua, regaderas y baños', 'Clima / aire acondicionado'].includes(c.tema) || OPER_KW.some((k) => t.includes(k))) return 'Riesgo para la operación';
  return rec(c) ? 'Queja recurrente no grave' : 'Queja no recurrente';
}

function merge(oldRows, newRows, key) {
  const m = new Map(); for (const r of oldRows) m.set(key(r), r); for (const r of newRows) m.set(key(r), r); return [...m.values()];
}
const k = (...a) => JSON.stringify(a.map((x) => (x === undefined ? null : x)));
const regReg = (reg) => (reg ? `${reg.replace('Región ', 'R')} · ${REGIONAL[reg]}` : '');

// state: { nombre: filas[] }, nuevos: [{ seccion: filas[] }, ...]  ->  { nombre: filas[] }
export async function correrPipeline(state, nuevos) {
  const S = (n) => state[n] || [];
  const secs = Object.fromEntries(SECCIONES.map((s) => [s, []]));
  for (const d of nuevos) for (const s of SECCIONES) secs[s].push(...(d[s] || []));

  const nuevosCom = [];
  for (const c0 of secs.comentarios) {
    const c = { ...c0 };
    c.tema = TEMAS.includes(c.tema) ? c.tema : 'Otro';
    c.sentimiento = ['negativo', 'positivo', 'neutral'].includes(c.sentimiento) ? c.sentimiento : 'negativo';
    const club = (c.marca === 'Planet Fitness' ? clubPorUrl(c.url) : '') || matchClub(c.club_texto || '', c.marca);
    const reg = club ? CLUBES[club][0] : '';
    const fin = c.periodo_fin || c.fecha;
    const id = c.url && ['SentiOne semanal', 'Google Reviews'].includes(c.fuente) ? await rid(c.url, c.marca) : await rid(c.fuente, fin, c.marca, norm(c.texto || '').slice(0, 120));
    nuevosCom.push({
      id, fecha: c.fecha || fin, periodo_fin: fin, semana: semanaDe(fin), mes: fin.slice(0, 7),
      fuente: c.fuente ?? null, marca: c.marca ?? null,
      club: c.marca === 'Planet Fitness' ? club : (c.club_texto || '').trim(),
      club_mencionado: (c.club_texto || '').trim(),
      region: reg, regional: REGIONAL[reg] || '', region_regional: regReg(reg),
      tema: c.tema, sentimiento: c.sentimiento, texto: (c.texto || '').slice(0, 300),
      canal: c.canal || '', calificacion_nps: c.calificacion_nps ?? null,
      categoria_fuente: c.categoria_riesgo_fuente || '', interacciones: c.interacciones || '',
      url: c.url || '', fuente_doc: c.fuente_doc || '', reporte_url: reporteUrl(c),
      calificacion_resena: c.calificacion_resena ?? null,
    });
  }
  const com = merge(S('comentarios'), nuevosCom, (r) => r.id);
  const ct = new Map(), tt = new Map();
  const add = (m, key, v) => { if (!m.has(key)) m.set(key, new Set()); m.get(key).add(v); };
  for (const r of com) if (r.sentimiento === 'negativo' && r.marca === 'Planet Fitness') { if (r.club) add(ct, r.club + '\u0000' + r.tema, r.semana); add(tt, r.tema, r.semana); }
  const rec = (r) => (r.club ? (ct.get(r.club + '\u0000' + r.tema)?.size || 0) >= 2 : (tt.get(r.tema)?.size || 0) >= 3);
  for (const r of com) { r.categoria = categoria(r, rec); r.recurrente = r.sentimiento === 'negativo' && rec(r) ? 'Sí' : 'No'; }
  com.sort((a, b) => (a.periodo_fin === b.periodo_fin ? (a.fuente < b.fuente ? 1 : a.fuente > b.fuente ? -1 : 0) : a.periodo_fin < b.periodo_fin ? 1 : -1));

  const addReg = (r, field = 'club_texto') => { const club = matchClub(r[field] || '', 'Planet Fitness'); const reg = club ? CLUBES[club][0] : ''; return { ...r, club: club || r[field] || '', region: reg, regional: REGIONAL[reg] || '' }; };
  const conSemana = (rows) => rows.map((r) => ({ ...r, semana: semanaDe(r.periodo_fin) }));
  const insN = [];
  for (const r of secs.insights) insN.push({ ...r, reporte_url: reporteUrl(r), id: await rid(r.fuente, r.periodo_fin, norm(r.texto).slice(0, 120)), semana: semanaDe(r.periodo_fin) });

  const out = {
    comentarios: com,
    nps_semanal: merge(S('nps_semanal'), conSemana(secs.nps_semanal), (r) => r.periodo_fin),
    nps_clubes: merge(S('nps_clubes'), secs.nps_clubes.map((r) => ({ ...addReg(r), semana: semanaDe(r.periodo_fin) })), (r) => k(r.periodo_fin, r.grupo, r.rank, r.club)),
    sl_semanal: merge(S('sl_semanal'), conSemana(secs.sl_semanal), (r) => k(r.periodo_fin, r.marca)),
    sl_canales: merge(S('sl_canales'), conSemana(secs.sl_canales), (r) => k(r.periodo_fin, r.marca, r.canal)),
    axol_semanal: merge(S('axol_semanal'), conSemana(secs.axol_semanal), (r) => r.periodo_fin),
    mensual: merge(S('mensual'), secs.mensual, (r) => k(r.mes, r.marca)),
    insights: merge(S('insights'), insN, (r) => r.id),
    clubes: Object.entries(CLUBES).map(([club, v]) => ({ club, region: v[0], regional: REGIONAL[v[0]], region_regional: regReg(v[0]), ciudad: v[1] })),
  };
  const byFin = (a, b) => (a.periodo_fin < b.periodo_fin ? -1 : a.periodo_fin > b.periodo_fin ? 1 : 0);
  for (const n of ['nps_semanal', 'nps_clubes', 'sl_semanal', 'sl_canales', 'axol_semanal', 'insights']) out[n].sort(byFin);
  out.mensual.sort((a, b) => (a.mes < b.mes ? -1 : a.mes > b.mes ? 1 : 0));
  for (const n of ['nps_clubes', 'sl_semanal', 'sl_canales', 'axol_semanal', 'mensual', 'nps_semanal', 'insights']) for (const r of out[n]) delete r.fuente_uri;
  return out;
}

// Footprint trimestral (port de footprint_merge.py)
export function mergeFootprint(state, nuevo) {
  const clubes = Object.fromEntries((state.clubes || []).map((c) => [c.club, c]));
  const out = {};
  for (const name of ['footprint_regiones', 'footprint_clubes', 'footprint_resumen']) {
    const rows = (nuevo[name] || []).map((r) => ({ ...r }));
    if (!rows.length) continue;
    const tris = new Set(rows.map((r) => r.trimestre));
    for (const r of rows) {
      if (name === 'footprint_clubes') {
        r.club_texto = r.club_texto || r.club;
        const m = matchClub((r.club_texto || '').replace('Gdl.', 'Guadalajara'), 'Planet Fitness');
        r.club = m || r.club_texto;
        const c = clubes[r.club]; if (c) { r.region = c.region; r.region_regional = c.region_regional; }
        if (r.senales == null) r.senales = r.alerta ? r.alerta.split(', ').length : 0;
      } else if (name === 'footprint_regiones' && REGIONAL[r.region]) r.region_regional = regReg(r.region);
    }
    const merged = [...(state[name] || []).filter((r) => !tris.has(r.trimestre)), ...rows];
    merged.sort((a, b) => k(a.trimestre, a.region, a.club) < k(b.trimestre, b.region, b.club) ? -1 : 1);
    out[name] = merged;
  }
  return out;
}
