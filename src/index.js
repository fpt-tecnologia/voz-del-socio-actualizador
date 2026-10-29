// Actualizador del dashboard "Voz del Socio" — corre en GitHub Actions (sin Claude).
// Horarios: L–V 10:41 y 15:41 (CDMX) y el botón "Actualizar ahora" del dashboard.
import { correrPipeline, mergeFootprint, SECCIONES, norm } from './pipeline.js';
import { buscarCorreos, adjuntos, cuerpoTexto, buscarArchivos, descargar, correosDesde, cuerpoConLigas } from './graph.js';
import { aTexto, esImagen, b64, pptxTexto } from './texto.js';
import { extraerReporte, clasificarMenciones } from './ia.js';
import { descargarMenciones, aComentarios } from './sentione.js';
import { generarRecomendaciones } from './recomendaciones.js';

const DATASETS = ['comentarios', 'nps_semanal', 'nps_clubes', 'nps_mensual', 'sl_semanal', 'sl_canales', 'axol_semanal', 'mensual', 'insights', 'clubes', 'footprint_regiones', 'footprint_clubes', 'footprint_resumen'];
const MESES = { ENERO: '01', FEBRERO: '02', MARZO: '03', ABRIL: '04', MAYO: '05', JUNIO: '06', JULIO: '07', AGOSTO: '08', SEPTIEMBRE: '09', OCTUBRE: '10', NOVIEMBRE: '11', DICIEMBRE: '12' };
const ahora = () => new Date().toISOString();
const maxDe = (rows, k) => rows.reduce((m, r) => (r[k] && r[k] > m ? r[k] : m), '');

async function leer(env, key, def = null) { const o = await env.DATOS.get(key); if (!o) return def; try { return await o.json(); } catch { return def; } }
async function escribir(env, key, val) { await env.DATOS.put(key, JSON.stringify(val), { httpMetadata: { contentType: 'application/json' } }); }

export async function correr(env, origen) {
  const prev = await leer(env, 'meta/estado.json', {});
  if (prev.estado === 'corriendo' && Date.now() - Date.parse(prev.inicio) < 20 * 60e3) return;
  const est = { estado: 'corriendo', origen, inicio: ahora(), pasos: [] };
  await escribir(env, 'meta/estado.json', est); await env.DATOS.delete('meta/solicitud.json');
  const paso = async (t) => { est.pasos.push(`${new Date().toISOString().slice(11, 16)} ${t}`); await escribir(env, 'meta/estado.json', est); };
  const errores = [], nuevos = [], fuentes = [];
  let fpNuevo = null; const buzonHechos = [];
  try {
    const state = {}; for (const d of DATASETS) state[d] = (await leer(env, `data/${d}.json`, [])) || [];
    const proc = await leer(env, 'meta/procesados.json', { ids: [] }); const hechos = new Set(proc.ids);
    const wmNps = maxDe(state.nps_semanal, 'periodo_fin'), wmAxol = maxDe(state.axol_semanal, 'periodo_fin'), wmMes = maxDe(state.mensual, 'mes'), wmFp = maxDe(state.footprint_regiones, 'trimestre');

    // 1) SentiOne: una extracción por semana (créditos de API limitados). Corre en la primera corrida a partir de 6.5 días de la anterior.
    try {
      const ult = await leer(env, 'meta/sentione.json', {});
      if (!ult.en || Date.now() - Date.parse(ult.en) > 6.5 * 864e5) {
        await paso('Descargando menciones de SentiOne');
        const { menciones, consultas } = await descargarMenciones(env.SENTIONE_KEY);
        await escribir(env, 'meta/sentione.json', { en: ahora(), consultas });
        const urls = new Set(state.comentarios.filter((r) => r.url).map((r) => r.marca + '|' + r.url));
        const nuevas = menciones.filter((m) => m.url && !urls.has(m.marca + '|' + m.url));
        if (nuevas.length) {
          await paso(`Clasificando ${nuevas.length} menciones nuevas`);
          const filas = aComentarios(nuevas, await clasificarMenciones(env, nuevas));
          if (filas.length) { nuevos.push({ comentarios: filas }); fuentes.push(`SentiOne API: ${filas.length} comentarios`); }
        }
        const fallas = consultas.filter((c) => c.error).map((c) => `${c.consulta}: ${c.error}`);
        if (fallas.length) errores.push('SentiOne: ' + fallas.join('; '));
      }
    } catch (e) { errores.push('SentiOne: ' + e.message); }

    // 1b) Alertas de SentiOne por correo (no gastan créditos de la API): buzón compartido ALERTAS_MAILBOX
    if (env.ALERTAS_MAILBOX) try {
      const wmA = await leer(env, 'meta/alertas.json', {});
      const ms = (await correosDesde(env, env.ALERTAS_MAILBOX, wmA.ultimo || null)).filter((m) => !hechos.has(m.id));
      let ultimo = wmA.ultimo || null, n = 0;
      for (const m of ms) {
        const de = (m.from?.emailAddress?.address || '').toLowerCase();
        if (!/sentione/.test(de) && !/sentione/i.test(m.subject || '')) { ultimo = m.receivedDateTime; continue; }
        await paso('Alerta de SentiOne: ' + (m.subject || '').slice(0, 80));
        const d = await extraerReporte(env, { texto: `ASUNTO: ${m.subject}\nRECIBIDO: ${m.receivedDateTime}\n\n${cuerpoConLigas(m)}`, contexto: { fuente: 'SentiOne alerta', fuente_doc: 'Alerta SentiOne · ' + (m.subject || ''), recibido: m.receivedDateTime,
          descripcion: 'Correo de alerta de SentiOne con menciones (normalmente negativas) en redes. Cada mención es UNA fila de "comentarios": fecha de la mención, texto (sin nombres de autores), canal (Facebook, Instagram, X, TikTok, Reddit, Google…), marca (Planet Fitness salvo que diga otra), club_texto si menciona sucursal, url = liga pública de la publicación (si solo viene la liga de sentione.com úsala). No generes otras secciones salvo insights si el correo trae un resumen.' } });
        for (const r of d.comentarios || []) { r.fuente = 'SentiOne alerta'; r.fecha = r.fecha || m.receivedDateTime.slice(0, 10); r.periodo_fin = r.periodo_fin || r.fecha; if (!r.fuente_doc) r.fuente_doc = 'Alerta SentiOne · ' + (m.subject || ''); }
        nuevos.push({ comentarios: d.comentarios || [], insights: (d.insights || []).map((r) => ({ ...r, fuente: 'SentiOne alerta' })) }); n += (d.comentarios || []).length;
        hechos.add(m.id); ultimo = m.receivedDateTime;
      }
      if (ultimo && ultimo !== wmA.ultimo) await escribir(env, 'meta/alertas.json', { ultimo, en: ahora() });
      if (n) fuentes.push(`Alertas SentiOne: ${n} menciones`);
    } catch (e) { errores.push('Alertas SentiOne: ' + e.message); }

    // Lee un correo completo (cuerpo + adjuntos) y extrae; descarta lo que ya estaba cargado
    const correo = async (m, fuente, wm, campoPeriodo) => {
      const adj = await adjuntos(env, m.id);
      const partes = [`ASUNTO: ${m.subject}\nRECIBIDO: ${m.receivedDateTime}\n\nCUERPO DEL CORREO:\n${cuerpoTexto(m)}`];
      const imagenes = [];
      for (const a of adj) {
        const t = await aTexto(a.nombre, a.bytes).catch(() => null);
        if (t) partes.push(`\n=== ADJUNTO: ${a.nombre} ===\n${t}`);
        else if (esImagen(a.nombre)) imagenes.push({ tipo: a.nombre.toLowerCase().endsWith('png') ? 'image/png' : 'image/jpeg', b64: b64(a.bytes) });
      }
      const uri = 'mail:///messages/' + encodeURIComponent(m.id);
      const d = await extraerReporte(env, { texto: partes.join('\n'), imagenes, contexto: { fuente, fuente_doc: m.subject, fuente_uri: uri, recibido: m.receivedDateTime } });
      for (const s of SECCIONES) for (const r of d[s] || []) { if (!r.fuente_uri && !r.reporte_url) r.fuente_uri = uri; if (!r.fuente_doc) r.fuente_doc = m.subject; }
      const per = maxDe(d[campoPeriodo] || [], 'periodo_fin');
      if (per && wm && per <= wm) { // semana ya cargada: solo se aprovechan cifras faltantes
        return { axol_semanal: campoPeriodo === 'axol_semanal' ? d.axol_semanal : [], _yaCargado: true };
      }
      return d;
    };

    // 2) Reporte semanal NPS + Social Listening (correo de Jair)
    try {
      await paso('Buscando el reporte semanal NPS + Social Listening');
      const ms = (await buscarCorreos(env, { buscar: 'Reporte semanal NPS', de: env.MAILBOX, desde: wmNps ? wmNps + 'T23:59:59Z' : null })).filter((m) => /social listening/i.test(m.subject) && !hechos.has(m.id));
      for (const m of ms) {
        await paso('Leyendo: ' + m.subject);
        const d = await correo(m, 'Reporte semanal NPS + Social Listening', wmNps, 'nps_semanal');
        if (!d._yaCargado) { nuevos.push(d); fuentes.push(m.subject); }
        hechos.add(m.id);
      }
    } catch (e) { errores.push('Reporte semanal: ' + e.message); }

    // 3) Axol (agencia) y resumen interno de redes
    try {
      await paso('Buscando reportes de Axol');
      const desde = wmAxol ? wmAxol + 'T23:59:59Z' : null;
      const ms = [...await buscarCorreos(env, { buscar: 'FPT weekly report', de: env.AXOL_FROM, desde }), ...await buscarCorreos(env, { buscar: 'Reporte semanal de redes sociales', de: env.REDES_FROM, desde })]
        .filter((m) => !hechos.has(m.id)).sort((a, b) => (a.receivedDateTime < b.receivedDateTime ? -1 : 1));
      for (const m of ms) {
        await paso('Leyendo: ' + m.subject);
        const d = await correo(m, 'Axol semanal', wmAxol, 'axol_semanal');
        nuevos.push(d); if (!d._yaCargado) fuentes.push(m.subject);
        hechos.add(m.id);
      }
    } catch (e) { errores.push('Axol: ' + e.message); }

    // 4) Reporte mensual de SentiOne (SharePoint)
    try {
      await paso('Buscando el reporte mensual en SharePoint');
      const fs = (await buscarArchivos(env, 'PF_Social Listening')).map((f) => { const mm = f.name.match(/PF_Social Listening_([A-ZÁÉÍÓÚ]+)-(\d{4})/i); return mm && MESES[mm[1].toUpperCase()] ? { ...f, mes: `${mm[2]}-${MESES[mm[1].toUpperCase()]}` } : null; })
        .filter((f) => f && (!wmMes || f.mes > wmMes) && /\.(pptx|pdf)$/i.test(f.name) && !hechos.has(f.id));
      const porMes = {}; for (const f of fs) if (!porMes[f.mes] || /\.pptx$/i.test(f.name)) porMes[f.mes] = f;
      for (const f of Object.values(porMes)) {
        await paso('Leyendo: ' + f.name);
        const texto = await aTexto(f.name, await descargar(env, f.id));
        const d = await extraerReporte(env, { texto, contexto: { fuente: 'SentiOne mensual', fuente_doc: f.name, reporte_url: f.webUrl, mes: f.mes } });
        for (const s of SECCIONES) for (const r of d[s] || []) { r.reporte_url = r.reporte_url || f.webUrl; r.fuente_doc = r.fuente_doc || f.name; }
        nuevos.push(d); fuentes.push(f.name); hechos.add(f.id);
      }
    } catch (e) { errores.push('Mensual: ' + e.message); }

    // 5) Footprint trimestral (Huellas)
    const leerFootprint = async (texto, ctx) => {
      const d = await extraerReporte(env, { texto, contexto: ctx, footprint: true });
      const res = (d.footprint_resumen || [])[0] || {}; const tri = res.trimestre || (d.footprint_regiones || [])[0]?.trimestre;
      const suma = (d.footprint_clubes || []).filter((c) => c.trimestre === tri).reduce((s, c) => s + (Number(c.socios) || 0), 0);
      const total = Number(res.socios) || Number((d.footprint_regiones || []).find((r) => r.region === 'Cadena')?.socios) || 0;
      if (!tri || !total || Math.abs(suma - total) > total * 0.002) throw new Error(`la suma de socios de los clubes (${suma}) no cuadra con el total del reporte (${total}); no se cargó`);
      return d;
    };
    try {
      await paso('Buscando el Footprint trimestral');
      const fs = await buscarArchivos(env, 'FOOTPRINT');
      const res = fs.map((f) => { const mm = f.name.match(/^FOOTPRINT_(\d{4})_Q(\d)_Resumen_regiones\.pptx$/i); return mm ? { ...f, tri: `${mm[1]}-Q${mm[2]}` } : null; })
        .filter((f) => f && (!wmFp || f.tri > wmFp) && !hechos.has(f.id)).sort((a, b) => (a.tri < b.tri ? -1 : 1));
      for (const f of res) {
        await paso('Leyendo: ' + f.name);
        const reg = fs.find((x) => x.name.toUpperCase() === `FOOTPRINT_${f.tri.replace('-Q', '_Q')}_REGION_1.PPTX`);
        let texto = `=== ${f.name} ===\n` + await aTexto(f.name, await descargar(env, f.id));
        if (reg) texto += `\n\n=== ${reg.name} (láminas 3 a 8: comparativo de todos los clubes) ===\n` + pptxTexto(await descargar(env, reg.id), [3, 8]);
        const d = await leerFootprint(texto, { fuente: 'Footprint trimestral', fuente_doc: f.name, reporte_url: f.webUrl, trimestre: f.tri });
        fpNuevo = d; nuevos.push({ insights: d.insights || [] }); fuentes.push(f.name); hechos.add(f.id);
      }
    } catch (e) { errores.push('Footprint: ' + e.message); }

    // 6) Buzón de reportes
    try {
      const lst = await env.DATOS.list({ prefix: 'envios/' });
      for (const o of lst.objects) {
        const fi = await leer(env, o.key); if (!fi || fi.estado !== 'pendiente') continue;
        await paso('Buzón: ' + fi.nombre);
        fi.estado = 'procesando'; await escribir(env, o.key, fi);
        try {
          const obj = await env.DATOS.get(fi.clave); if (!obj) throw new Error('no se encontró el archivo');
          const bytes = await obj.arrayBuffer();
          const texto = await aTexto(fi.nombre, bytes);
          const imagenes = !texto && esImagen(fi.nombre) ? [{ tipo: fi.tipo_archivo || 'image/jpeg', b64: b64(bytes) }] : [];
          if (!texto && !imagenes.length) throw new Error('formato no legible; súbelo como PDF');
          const ctx = { fuente: fi.tipo, fuente_doc: fi.nombre, reporte_url: 'https://reporteslistening.fpt.com.mx', desde: fi.desde, hasta: fi.hasta, nota: fi.nota };
          if (fi.tipo === 'Footprint trimestral') { const d = await leerFootprint(texto, ctx); fpNuevo = d; nuevos.push({ insights: d.insights || [] }); buzonHechos.push({ key: o.key, fi, footprint: d }); }
          else { const d = await extraerReporte(env, { texto, imagenes, contexto: ctx });
            for (const s of SECCIONES) for (const r of d[s] || []) { r.reporte_url = 'https://reporteslistening.fpt.com.mx'; r.fuente_doc = fi.nombre; if (s === 'comentarios' && !r.fuente) r.fuente = fi.tipo; }
            nuevos.push(d); buzonHechos.push({ key: o.key, fi, d }); }
          fuentes.push('Buzón: ' + fi.nombre);
        } catch (e) { fi.estado = 'error'; fi.resultado = 'No se pudo procesar: ' + e.message; fi.procesado_en = ahora(); await escribir(env, o.key, fi); errores.push(`Buzón (${fi.nombre}): ${e.message}`); }
      }
    } catch (e) { errores.push('Buzón: ' + e.message); }

    await escribir(env, 'meta/procesados.json', { ids: [...hechos].slice(-500) });

    // 7) Integrar y publicar
    const resumen = { fuentes, comentarios_nuevos: 0, riesgo_socio: 0, riesgo_operacion: 0 };
    if (nuevos.length || fpNuevo) {
      await paso('Integrando y publicando');
      // Axol: no perder cifras ya cargadas si un correo trae menos datos
      const axolPrev = Object.fromEntries(state.axol_semanal.map((r) => [r.periodo_fin, r]));
      for (const d of nuevos) d.axol_semanal = (d.axol_semanal || []).map((r) => { const p = axolPrev[r.periodo_fin]; if (!p) return r; const o = { ...p }; for (const [k2, v] of Object.entries(r)) if (v !== null && v !== undefined && v !== '') o[k2] = v; return o; });
      const out = await correrPipeline(state, nuevos);
      if (fpNuevo) Object.assign(out, mergeFootprint(state, fpNuevo));
      for (const [k2, rows] of Object.entries(out)) if ((state[k2] || []).length > rows.length) throw new Error(`${k2} perdería filas (${state[k2].length} → ${rows.length}); no se publicó nada`);
      const idsPrev = new Set(state.comentarios.map((r) => r.id));
      const nuevosCom = out.comentarios.filter((r) => !idsPrev.has(r.id));
      resumen.comentarios_nuevos = nuevosCom.length;
      resumen.riesgo_socio = nuevosCom.filter((r) => r.categoria === 'Riesgo para el socio').length;
      resumen.riesgo_operacion = nuevosCom.filter((r) => r.categoria === 'Riesgo para la operación').length;
      for (const [k2, rows] of Object.entries(out)) if (JSON.stringify(rows) !== JSON.stringify(state[k2] || [])) await escribir(env, `data/${k2}.json`, rows);
      for (const b of buzonHechos) {
        const cs = nuevosCom.filter((r) => r.fuente_doc === b.fi.nombre);
        const clubs = [...new Set(cs.map((r) => r.club).filter(Boolean))].slice(0, 4);
        b.fi.estado = 'procesado'; b.fi.procesado_en = ahora();
        b.fi.resultado = b.footprint ? `Footprint ${(b.footprint.footprint_resumen || [])[0]?.trimestre || ''} cargado: ${(b.footprint.footprint_clubes || []).length} clubes`
          : `${cs.length} comentarios nuevos · ${cs.filter((r) => /^Riesgo/.test(r.categoria)).length} de riesgo${clubs.length ? ' · clubes: ' + clubs.join(', ') : ''}`;
        await escribir(env, b.key, b.fi);
      }
    }
    // 8) Qué mejorar: recomendaciones con IA cuando entran datos nuevos o la última tiene más de 7 días
    try {
      const prevRec = await leer(env, 'data/recomendaciones.json', null);
      const vieja = !prevRec?.[0]?.generado_en || Date.now() - Date.parse(prevRec[0].generado_en) > 7 * 864e5;
      if (resumen.comentarios_nuevos > 0 || fpNuevo || vieja) {
        await paso('Generando recomendaciones de mejora');
        const st2 = {}; for (const d of DATASETS) st2[d] = (await leer(env, `data/${d}.json`, [])) || [];
        const rec = await generarRecomendaciones(env, st2);
        if (rec) { await escribir(env, 'data/recomendaciones.json', [rec]); resumen.recomendaciones = rec.items.length; }
      }
    } catch (e) { errores.push('Recomendaciones: ' + e.message); }

    Object.assign(est, { estado: errores.length ? 'ok_con_errores' : 'ok', fin: ahora(), resumen, errores });
    await escribir(env, 'meta/estado.json', est);
    await escribir(env, 'meta/ultima.json', { fin: est.fin, origen, resumen, errores });
  } catch (e) {
    Object.assign(est, { estado: 'error', fin: ahora(), errores: [...errores, e.message] });
    await escribir(env, 'meta/estado.json', est);
  }
}
