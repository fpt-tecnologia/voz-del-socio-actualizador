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

export async function descargarMenciones(key, lista = CONSULTAS) {
  const vistos = new Set(), menciones = [], consultas = []; let restante = null;
  for (const [pid, marca, fuente, filtros, orden, maxp] of lista) {
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

// Reporte semanal: muestra completa de la semana por marca (para volumen, sentimiento y canales) + reseñas de Google.
// 29 llamadas en total: cabe en el límite de 30 por hora y en los créditos de la API.
export const SEMANAL = [
  [1181952, 'Planet Fitness', 'SentiOne semanal', { type: PUBLICOS }, 'PublishedAtDescending', 16],
  [1181964, 'Smart Fit', 'SentiOne semanal', { type: PUBLICOS }, 'PublishedAtDescending', 9],
  [1181965, 'Fitsi', 'SentiOne semanal', { type: PUBLICOS }, 'PublishedAtDescending', 2],
  [1181954, 'Planet Fitness', 'Google Reviews', {}, 'PublishedAtDescending', 2],
];
const CANAL = (c) => ({ Reviews: 'Google', Twitter: 'X' }[c] || c || 'Otro');

// Arma sl_semanal, sl_canales, comentarios e insights a partir de la muestra semanal y la clasificación de la IA
export function resumenSemanal(menciones, clasif, consultas, periodo_inicio, periodo_fin) {
  const out = { sl_semanal: [], sl_canales: [], comentarios: [], insights: [] };
  const fuente_doc = `API de SentiOne · semana ${periodo_inicio} a ${periodo_fin}`;
  for (const marca of ['Planet Fitness', 'Smart Fit', 'Fitsi']) {
    const ms = menciones.filter((m) => m.marca === marca && m.fuente === 'SentiOne semanal');
    const inc = ms.filter((m) => { const c = clasif.get(String(m.id)); return !m.es_cuenta_oficial && (!c || c.incluir !== false); });
    const cnt = (s) => inc.filter((m) => m.sentimiento === s).length;
    const tope = consultas.some((c) => c.consulta.startsWith(marca + ' · SentiOne semanal') && !c.completo);
    out.sl_semanal.push({ periodo_inicio, periodo_fin, marca, muestra_api: ms.length, excluidas: ms.length - inc.length, incluidas: inc.length, positivas: cnt('Positive'), neutras: cnt('Neutral') + cnt('Unspecified'), negativas: cnt('Negative'), ambiguas: cnt('Ambiguous'), tope_alcanzado: tope, fuente_doc });
    const canales = new Map(); for (const m of inc) canales.set(CANAL(m.canal), (canales.get(CANAL(m.canal)) || 0) + 1);
    for (const [canal, n] of canales) out.sl_canales.push({ periodo_fin, marca, canal, menciones: n, fuente_doc });
    // Comentarios: todas las negativas y las 5 positivas de más engagement
    const pos = inc.filter((m) => m.sentimiento === 'Positive').sort((a, b) => (b.engagement_rate || 0) - (a.engagement_rate || 0)).slice(0, 5);
    const neg = inc.filter((m) => m.sentimiento === 'Negative');
    out.comentarios.push(...aComentarios([...neg, ...pos], clasif).map((r) => ({ ...r, periodo_inicio, periodo_fin, fuente_doc })));
    const pct = inc.length ? Math.round(cnt('Negative') / inc.length * 1000) / 10 : null;
    const topC = [...canales].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c, n]) => `${c} (${n})`).join(', ');
    out.insights.push({ periodo_fin, fuente: 'SentiOne semanal', tipo: 'dato', texto: `${marca}: ${inc.length} menciones de México en la semana${tope ? ' (se alcanzó el tope de la muestra)' : ''}, ${pct ?? '—'}% negativas (${cnt('Negative')}) y ${cnt('Positive')} positivas. Canales principales: ${topC || '—'}.`, fuente_doc });
    const top = [...neg].sort((a, b) => (b.engagement_rate || 0) - (a.engagement_rate || 0))[0];
    if (top && marca === 'Planet Fitness') out.insights.push({ periodo_fin, fuente: 'SentiOne semanal', tipo: 'alerta', texto: `Negativa de mayor impacto (${CANAL(top.canal)}): “${(top.texto || '').slice(0, 180)}”`, reporte_url: top.url || null, fuente_doc });
  }
  // Menciones cruzadas: competidores que hablan de Planet Fitness
  const cruz = menciones.filter((m) => m.marca !== 'Planet Fitness' && /planet ?fitness|@planetfitness/i.test(m.texto || ''));
  out.insights.push({ periodo_fin, fuente: 'SentiOne semanal', tipo: 'dato', texto: cruz.length ? `Menciones cruzadas: ${cruz.length} menciones de competidores que nombran a Planet Fitness (${[...new Set(cruz.map((m) => m.marca))].join(', ')}).` : 'Menciones cruzadas: ninguna mención de competidores nombró a Planet Fitness esta semana.', fuente_doc });
  // Reseñas de Google
  const gr = menciones.filter((m) => m.fuente === 'Google Reviews');
  out.comentarios.push(...aComentarios(gr, clasif).map((r) => ({ ...r, periodo_inicio, periodo_fin, fuente_doc })));
  return out;
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
