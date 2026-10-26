// Punto de entrada en GitHub Actions: arma el entorno y corre la actualización completa.
import { correr } from './index.js';
import { DATOS } from './r2.js';
const env = { ...process.env, DATOS };
const falta = ['CF_TOKEN', 'CF_ACCOUNT_ID', 'SENTIONE_KEY', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_KEY'].filter((k) => !env[k]);
if (falta.length) { console.error('Faltan secretos/variables: ' + falta.join(', ')); process.exit(1); }
const sol = await (await DATOS.get('meta/solicitud.json'))?.json().catch(() => null);
const origen = process.env.GITHUB_EVENT_NAME === 'schedule' ? 'programada' : `botón (${sol?.por || process.env.GITHUB_ACTOR || 'manual'})`;
await correr(env, origen);
const est = await (await DATOS.get('meta/estado.json')).json();
// El repositorio es público y sus logs también: aquí solo se imprimen conteos. El detalle (fuentes, errores) queda en meta/estado.json, que solo se ve con cuenta @fpt.com.mx en el dashboard.
const r = est.resumen || {};
console.log(`estado: ${est.estado} · fuentes nuevas: ${(r.fuentes || []).length} · comentarios nuevos: ${r.comentarios_nuevos || 0} · errores: ${(est.errores || []).length}`);
if (est.estado === 'error') process.exit(1);
