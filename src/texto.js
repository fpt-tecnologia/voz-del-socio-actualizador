// Convierte archivos a texto dentro del Worker: Word (.docx), PowerPoint (.pptx), PDF, CSV/TXT/JSON/MD.
import { unzipSync, strFromU8 } from 'fflate';

const xmlText = (xml) => xml
  .replace(/<w:tab\/>|<a:tab\/>/g, '\t')
  .replace(/<\/w:p>|<\/a:p>|<w:br\/>|<a:br\/>/g, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

export function docxTexto(bytes) {
  const z = unzipSync(new Uint8Array(bytes), { filter: (f) => /^word\/(document|footnotes)\.xml$/.test(f.name) });
  // las tablas quedan como celdas separadas por tab
  const doc = strFromU8(z['word/document.xml'] || new Uint8Array())
    .replace(/<w:tc[ >][\s\S]*?<\/w:tc>/g, (c) => c.replace(/<\/w:p>/g, ' ') + '\t').replace(/<\/w:tr>/g, '</w:p>');
  return xmlText(doc).trim();
}

// slides: [desde, hasta] 1-based opcional
export function pptxTexto(bytes, slides) {
  const z = unzipSync(new Uint8Array(bytes), { filter: (f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.name) });
  const nums = Object.keys(z).map((n) => Number(n.match(/slide(\d+)\.xml/)[1])).sort((a, b) => a - b);
  return nums.filter((n) => !slides || (n >= slides[0] && n <= slides[1]))
    .map((n) => `--- Lámina ${n} ---\n` + xmlText(strFromU8(z[`ppt/slides/slide${n}.xml`]).replace(/<a:tc[ >][\s\S]*?<\/a:tc>/g, (c) => c.replace(/<\/a:p>/g, ' ') + '\t').replace(/<\/a:tr>/g, '</a:p>')).trim()).join('\n');
}

export async function pdfTexto(bytes, maxPaginas = 60) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.slice(0, maxPaginas).map((t, i) => `--- Página ${i + 1} ---\n${t}`).join('\n');
}

export async function aTexto(nombre, bytes, opts = {}) {
  const n = (nombre || '').toLowerCase();
  if (n.endsWith('.docx')) return docxTexto(bytes);
  if (n.endsWith('.pptx')) return pptxTexto(bytes, opts.slides);
  if (n.endsWith('.pdf')) return pdfTexto(bytes);
  if (/\.(csv|txt|md|json|tsv)$/.test(n)) return new TextDecoder().decode(bytes);
  return null; // imágenes: se mandan al modelo como imagen
}

export const esImagen = (nombre) => /\.(png|jpe?g|webp)$/i.test(nombre || '');
export function b64(bytes) {
  let s = ''; const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
