// Port de sentione_fetch.py + conversión a filas de comentarios (sección "Menciones de la API" del esquema).
const BASE = 'https://sentione.com/api/public/v2/projects/{pid}/mentions/recent/search';
const PUBLICOS = ['Post', 'Comment', 'Share', 'Article'];
const CONSULTAS = [
  [1181952, 'Planet Fitness', 'SentiOne semanal', { content: { sentiment: ['Negative'] }, type: PUBLICOS }, 'EngagementRateDescending', 7],
  [1181952, 'Planet Fitness', 'SentiOne semanal', { content: { sentiment: ['Positive'] }, type: PUBLICOS }, 'EngagementRateDescending', 1],
  [1181954, 'Planet Fitness', 'Google Reviews', {}, 'PublishedAtDescending', 5],
  [1181964, 'Smart Fit', 'SentiOne semanal', { content: { sentiment: ['Negative'] }, type: PUBLICOS }, 'EngagementRateDescending', 5],
  [1181964, 'Smart Fit', 'SentiOne semanal', { content: { sentiment: ['Positive'] }, type: PUBLICOS }, 'EngagementRateDescending', 1],
  [1181965, 'Fitsi', 'SentiOne semanal', { content: { sentiment: ['Negative'] }, type: PUBLICOS }, 'EngagementRateDescending', 2],
  [1181965, 'Fitsi', 'SentiOne semanal', { content: { sentiment: ['Positive'] }, type: PUBLICOS }, 'EngagementRateDescending', 1],
];

function slim(m, marca, fuente, pid) {
  const c = m.content || {}, src = m.source || {}, em = m.engagementMetrics || {};
  const inter = {};
  for (const plat of Object.values(em.sourceMetrics || {})) if (plat && typeof plat === 'object') for (const [k, v] of Object.entries(plat)) if (typeof v === 'number' && v) inter[k] = (inter[k] || 0) + v;
  const canalOf = src.socialChannel?.id, autor = m.author?.id;
  return { id: m.id, proyecto: pid, marca, fuente, tipo: m.type, fecha: (m.publishedAt || '').slice(0, 10), texto: (c.text || '').slice(0, 600),
    idioma: c.language?.code, sentimiento: c.sentiment || 'Unspecified', canal: src.type, url: src.mentionUrl,
    calificacion_resena: c.review?.rating?.value ?? null, engagement_rate: em.engagementRate, interacciones: inter, es_cuenta_oficial: !!(autor && canalOf && autor === canalOf) };
}

export async function descargarMenciones(key) {
  const vistos = new Set(), menciones = [], consultas = []; let restante = null;
  for (const [pid, marca, fuente, filtros, orden, maxp] of CONSULTAS) {
    let cursor = null, n = 0, error = null, completo = false;
    for (let p = 0; p < maxp; p++) {
      if (restante !== null && Number(restante) <= 1) { error = 'límite de 30 llamadas/hora alcanzado'; break; }
      let r;
      try {
        r = await fetch(BASE.replace('{pid}', pid) + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ filters: filtros, sortType: orden }) });
      } catch (e) { error = String(e).slice(0, 120); break; }
      restante = r.headers.get('x-rate-limit-remaining');
      if (!r.ok) { error = 'HTTP ' + r.status; break; }
      const d = await r.json(); const data = d.data || [];
      for (const m of data) if (!vistos.has(m.id) && m.type !== 'PrivateMessage') { vistos.add(m.id); menciones.push(slim(m, marca, fuente, pid)); n++; }
      cursor = d.cursor; if (!cursor || !data.length) { completo = true; break; }
    }
    consultas.push({ consulta: `${marca} · ${fuente} · ${filtros.content?.sentiment?.[0] || 'todas'}`, menciones: n, completo, error });
  }
  return { menciones, consultas, restante };
}

const SENT = { Negative: 'negativo', Positive: 'positivo' };
const interTxt = (o) => { const p = []; if (o.likes || o.reactions) p.push(`${o.likes || o.reactions} likes`); if (o.comments) p.push(`${o.comments} comentarios`); if (o.shares) p.push(`${o.shares} compartidos`); return p.join(' · ') || null; };

export function aComentarios(menciones, clasif) {
  const out = [];
  for (const m of menciones) {
    if (m.es_cuenta_oficial) continue;
    const c = clasif.get(String(m.id)); if (!c || c.incluir === false) continue;
    const canal = m.canal === 'Reviews' ? 'Google' : m.canal || null;
    out.push({ fecha: m.fecha, periodo_inicio: m.fecha, periodo_fin: m.fecha, fuente: m.fuente, marca: m.marca, club_texto: c.club_texto || '', tema: c.tema,
      sentimiento: SENT[m.sentimiento] || 'neutral', texto: (m.texto || '').slice(0, 280), canal, calificacion_nps: null, categoria_riesgo_fuente: null,
      interacciones: interTxt(m.interacciones || {}), url: m.url || null, reporte_url: null, calificacion_resena: m.calificacion_resena ?? null,
      fuente_doc: 'API de SentiOne', fuente_uri: '' });
  }
  return out;
}
