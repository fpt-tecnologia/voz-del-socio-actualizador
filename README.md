# Voz del Socio · Actualizador

Mantiene al día el dashboard **https://listening.fpt.com.mx** (Planet Fitness México · Fitness Para Todos).

Corre en GitHub Actions lunes a viernes a las 10:41 y 15:41 (CDMX) y cuando alguien da clic en **Actualizar ahora** en el dashboard.

Qué hace en cada corrida:
1. Lee el estado actual del dashboard en Cloudflare R2 (`data/*.json`).
2. Baja menciones de SentiOne (máx. una vez por hora por el límite de su API) y las clasifica con Azure OpenAI.
3. Busca en el correo (Microsoft Graph, solo lectura) el reporte semanal NPS + Social Listening y los reportes de Axol.
4. Busca en SharePoint (MARKETINGTEAM) el reporte mensual de SentiOne y el Footprint trimestral.
5. Procesa lo que el equipo sube al buzón (reporteslistening.fpt.com.mx).
6. Integra todo (`src/pipeline.js`: clubes, regiones, categorías de riesgo, recurrencia) y publica en R2.

Estado de la última corrida: `meta/estado.json` en R2 (el dashboard lo muestra junto al botón).

## Configuración (Settings → Secrets and variables → Actions)
Secretos: `CF_TOKEN`, `SENTIONE_KEY`, `GRAPH_CLIENT_SECRET`, `AZURE_OPENAI_KEY`.
Variables: `CF_ACCOUNT_ID`, `TENANT_ID`, `GRAPH_CLIENT_ID`, `MAILBOX`, `SP_HOST`, `SP_SITE`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`.
