# Esquema de extracción — Dashboard VoC Planet Fitness México (FPT)

Todas las fechas en ISO `YYYY-MM-DD`. Números como números (no texto). Si un dato no viene en la fuente, usa `null` (nunca inventes ni estimes).
Cada fila lleva `fuente_doc`: nombre del archivo o asunto del correo del que salió, y `fuente_uri`: el URI mail:/// o file:/// que leíste.

## comentarios (una fila por queja/comentario individual citado en el reporte)
```
{
  "fecha": "2026-10-19",            // fin de la ventana del reporte (o fecha del comentario si la trae)
  "periodo_inicio": "2026-10-12",
  "periodo_fin": "2026-10-19",
  "fuente": "NPS Qualtrics" | "SentiOne semanal" | "Axol semanal" | "SentiOne mensual" | "Google Reviews",
  "marca": "Planet Fitness" | "Smart Fit" | "Fitsi",
  "club_texto": "Paseo Acoxpa",     // tal como lo nombra la fuente; "" si no menciona club
  "tema": uno de ["Cobros y cancelación","Mantenimiento y equipos","Agua, regaderas y baños","Clima / aire acondicionado","Limpieza","Seguridad y robo","Acoso o discriminación","Atención del personal","Coaches / entrenadores","Saturación","App y registro","PF Cuts y amenidades Black","Horarios y acceso","Promociones y precio","Otro"],
  "sentimiento": "negativo" | "positivo" | "neutral",
  "texto": "cita textual o resumen fiel, máx. 280 caracteres",
  "canal": "Facebook" | "Instagram" | "X" | "TikTok" | "Google" | "Encuesta" | "YouTube" | "Web" | null,
  "calificacion_nps": 0-10 o null,   // solo NPS
  "categoria_riesgo_fuente": "Legal / Cobros" ... o null,  // la etiqueta que trae el reporte NPS, tal cual
  "interacciones": "21 compartidos" o null,  // texto corto con el alcance que reporte la fuente
  "url": "https://..." o null,     // liga directa a la publicación o reseña (en la API: mentionUrl); ponla siempre que exista, salvo mensajes privados
  "reporte_url": "https://..." o null, // liga web al reporte fuente (webUrl de SharePoint, o deja fuente_uri y el pipeline la arma)
  "calificacion_resena": 1-5 o null, // estrellas de una reseña de Google
  "fuente_doc": "...", "fuente_uri": "..."
}
```
Incluye TODAS las quejas con contenido concreto (hallazgos de riesgo NPS, comentarios negativos de alto impacto, quejas recurrentes mencionadas en notas/lectura rápida con club, watchlist de clubes negativos en Google Reviews como una fila por club con el resumen). Incluye también comentarios positivos destacados (sentimiento positivo). No incluyas datos personales: nunca correos, teléfonos ni nombres de socios (sí nombres de clubes y de influencers/marcas públicas). Para competidores (Smart Fit, Fitsi) club_texto puede ser la sucursal del competidor.

## nps_semanal
`{"periodo_inicio","periodo_fin","nps","respuestas","clubes_con_muestra","hallazgos_riesgo","reporte_num","fuente_doc","fuente_uri"}`

## nps_clubes (top 5 y bottom 5 de cada semana)
`{"periodo_fin","club_texto","nps","n","rank","rank_previo","grupo":"top"|"bottom","fuente_doc"}`

## sl_semanal (SentiOne semanal por marca, ya filtrado a México)
`{"periodo_inicio","periodo_fin","marca","muestra_api","excluidas","incluidas","positivas","neutras","negativas","ambiguas","tope_alcanzado":true|false,"fuente_doc"}`

## sl_canales
`{"periodo_fin","marca","canal","menciones","fuente_doc"}`

## axol_semanal (reporte de Axol Marketing / Rafael Terrones, y el resumen de Jaime)
`{"periodo_inicio","periodo_fin","menciones","menciones_prev","alcance","alcance_prev","positivas","positivas_prev","neutras","negativas","negativas_prev","facebook","instagram","google_my_business","email","x","fuente_doc"}`

## mensual (reporte mensual SentiOne de la agencia, por marca)
`{"mes":"2026-09","marca","menciones","positivas","negativas","facebook","instagram","tiktok","x","articulos","alcance","engagement_rate","brand_health","fuente_doc"}`
Más, por mes solo para Planet Fitness si vienen: `brand_health_reviews`, `pct_negativas_reviews`, `brand_health_mantenimiento` (puedes ponerlos como campos extra en la fila de Planet Fitness).

## insights (hallazgos/recomendaciones textuales del periodo)
`{"periodo_fin","fuente","tipo":"hallazgo"|"recomendacion"|"alerta","texto":"máx 300 caracteres","fuente_doc"}`

## Menciones de la API de SentiOne (sentione_fetch.py)
- Cada mención trae id, marca, fuente, tipo, fecha, texto, sentimiento, canal, url, calificacion_resena, engagement_rate, interacciones, es_cuenta_oficial.
- Convierte a comentarios: fecha = periodo_inicio = periodo_fin = fecha de publicación; url = url; texto = texto (máx 280); canal = canal ("Reviews" -> "Google"); sentimiento en minúsculas (Negative->negativo, Positive->positivo, otro->neutral); calificacion_resena; interacciones como texto corto ("12 likes · 3 compartidos").
- Reseñas de Google (fuente "Google Reviews"): club_texto = el nombre de lugar de la URL (/maps/place/<nombre>/); el pipeline asigna el club por el place id.
- Excluye: menciones de la cuenta oficial (es_cuenta_oficial), las que no son de México con evidencia razonable (idioma distinto, modismos o ubicaciones de otro país) y las que no hablan de la marca (p. ej. #fitsinspo, otro "Smart Fit" que no es el gimnasio).

## Footprint trimestral (Huellas) — un JSON aparte, se integra con footprint_merge.py
Fuente: SharePoint MARKETINGTEAM, carpeta "MKT 2026/16. RESULTADOS DE VENTAS & PERFOMANCE DE CAMPAÑAS/HUELLAS" (en años siguientes busca la carpeta HUELLAS de "MKT <año>"). Por trimestre hay FOOTPRINT_<año>_Q<n>_Resumen_regiones.pptx y FOOTPRINT_<año>_Q<n>_Region_<1-5>.pptx.
- Lee el Resumen completo (≈12 láminas). De UN deck de región lee solo las páginas 3 a 8 (comparativo general de TODOS los clubes y crecimiento por trimestre de TODOS los clubes); no hace falta leer los 5 decks ni las fichas por club.
- trimestre = "<año>-Q<n>", periodo_fin = último día del trimestre. reporte_url = webUrl de la carpeta o del archivo. Porcentajes como número (95, no "95%"). "n/d" = null. Negativos con signo.
```
{"footprint_regiones": [ {trimestre, periodo_fin, region:"Región 1".."Región 5"|"Cadena", clubes, socios, vs_dic, vs_dic_pct, neto_q1, neto_q2, neto_q3, neto_q4, joins_anio, joins_meta_pct, bc_ventas_pct, nps_3m, nps_encuestas_q, google, mejorar:"Tema 21% · Tema 21%", reporte_url, fuente_doc} ],
 "footprint_clubes": [ {trimestre, periodo_fin, club_texto (tal como viene, sin "(R1)"), region_fuente:"R1", rank, socios, vs_dic, vs_anio_pct, joins_anio, joins_meta_pct, trafico_meta_pct, conversion_pct, bc_ventas_pct, meses_canc_sobre_max (el X de "X de 9"), nps_3m, vs_rampa, socios_q1, neto_q1, socios_q2, neto_q2, socios_q3, neto_q3, neto_q3_pct, socios_q4, neto_q4, neto_q4_pct, alerta:"texto de 'Clubes que requieren atención' o null", senales: número de la tabla de la cadena o null, reporte_url, fuente_doc} ],
 "footprint_resumen": [ {trimestre, periodo_fin, socios, vs_dic, vs_dic_pct, neto_q, joins_meta_pct, joins_anio, nps_encuestas, nps_encuestas_prev, encuestas, google, resenas_google, bc_ventas_pct, clubes_abiertos, clubes_alerta, destacados:["bullets de 'Lo más importante' y lecturas clave"], prioridades:[["acción", número de clubes], ...], reporte_url, fuente_doc} ]}
```
Los textos de alerta de cada club salen de las láminas "Clubes que requieren atención" (por región) y de la tabla de la cadena. Sin datos personales.
