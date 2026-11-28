// Turns renderer/manual.md (a small subset of Markdown) into HTML, plain text and PDF.
// Supported: # / ## / ### headings, paragraphs, "- " bullets, "1. " numbered lists,
// **bold** and `code`.
const fs = require('fs');
const path = require('path');

function source(version) {
  return fs.readFileSync(path.join(__dirname, 'renderer', 'manual.md'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\{\{version\}\}/g, version);
}

// Splits the text into blocks: {type: 'h1'|'h2'|'h3'|'p'|'ul'|'ol', text | items}.
function blocks(md) {
  const out = [];
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) { out.push({ type: 'p', text: para.join(' ') }); para = []; }
    if (list) { out.push(list); list = null; }
  };
  for (const line of md.split('\n')) {
    const t = line.trim();
    let m;
    if (!t) { flush(); continue; }
    if ((m = t.match(/^(#{1,3})\s+(.*)$/))) { flush(); out.push({ type: `h${m[1].length}`, text: m[2] }); continue; }
    if ((m = t.match(/^-\s+(.*)$/))) {
      if (para.length) { out.push({ type: 'p', text: para.join(' ') }); para = []; }
      if (!list || list.type !== 'ul') { if (list) out.push(list); list = { type: 'ul', items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    if ((m = t.match(/^\d+\.\s+(.*)$/))) {
      if (para.length) { out.push({ type: 'p', text: para.join(' ') }); para = []; }
      if (!list || list.type !== 'ol') { if (list) out.push(list); list = { type: 'ol', items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    if (list) { out.push(list); list = null; }
    para.push(t);
  }
  flush();
  return out;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inlineHtml = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
const inlineText = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1');

function toHtmlBody(md) {
  return blocks(md).map((b) => {
    if (b.type === 'ul' || b.type === 'ol') return `<${b.type}>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</${b.type}>`;
    return `<${b.type}>${inlineHtml(b.text)}</${b.type}>`;
  }).join('\n');
}

// Word-wraps to `width` columns, with a hanging indent for list items.
function wrap(text, width, first = '', rest = first) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = first;
  for (const w of words) {
    const pad = line === first || line === rest ? '' : ' ';
    if ((line + pad + w).length > width && line.trim()) { lines.push(line); line = rest + w; }
    else line += pad + w;
  }
  if (line.trim()) lines.push(line);
  return lines.join('\r\n');
}

function toText(md) {
  const out = [];
  for (const b of blocks(md)) {
    if (b.type === 'h1') { const t = inlineText(b.text).toUpperCase(); out.push(t, '='.repeat(t.length)); }
    else if (b.type === 'h2') { const t = inlineText(b.text).toUpperCase(); out.push('', t, '-'.repeat(t.length)); }
    else if (b.type === 'h3') out.push(inlineText(b.text));
    else if (b.type === 'p') out.push(wrap(inlineText(b.text), 78));
    else b.items.forEach((i, n) => {
      const mark = b.type === 'ol' ? `  ${n + 1}. ` : '  * ';
      out.push(wrap(inlineText(i), 78, mark, ' '.repeat(mark.length)));
    });
    out.push('');
  }
  return out.join('\r\n').replace(/(\r\n){3,}/g, '\r\n\r\n');
}

const PRINT_CSS = `
  body { font: 11pt/1.45 "Segoe UI", Arial, sans-serif; color: #1b1c1f; margin: 0; }
  h1 { font-size: 22pt; margin: 0 0 4pt; }
  h1 + p { color: #666; margin-top: 0; }
  h2 { font-size: 15pt; margin: 18pt 0 4pt; padding-bottom: 3pt; border-bottom: 2px solid #b01d10; break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 10pt 0 2pt; break-after: avoid; }
  p, li { margin: 3pt 0; }
  ul, ol { margin: 3pt 0; padding-left: 18pt; }
  code { font-family: Consolas, monospace; font-size: 10pt; background: #f1f1f3; padding: 0 3px; border-radius: 3px; }
`;

function toPrintHtml(md) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Breaker 40 CB Manual</title><style>${PRINT_CSS}</style></head><body>${toHtmlBody(md)}</body></html>`;
}

module.exports = { source, toHtmlBody, toText, toPrintHtml };
