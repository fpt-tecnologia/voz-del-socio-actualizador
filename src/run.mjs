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
console.log(JSON.stringify({ estado: est.estado, resumen: est.resumen, errores: est.errores, pasos: est.pasos }, null, 2));
if (est.estado === 'error') process.exit(1);
