const MAX_ENCODED_LENGTH = 4096;
const MAX_PAYLOAD_BYTES = 2048;
const STORE_ID = /^R\d{1,6}$/;
const MODEL_ID = /^[a-z][a-z0-9_-]{0,63}$/i;
const LABEL = /^[\p{L}\p{N} .+()'-]+$/u;

const error = message => new Error(message);
const normalizeLabel = (value, name, maximum = 80) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || !LABEL.test(value)) throw error(`This hunt has an invalid ${name}.`);
  return value.trim();
};

function sharedSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('This hunt link is not valid.');
  const requested = value.selection;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested) || !MODEL_ID.test(requested.modelId || '')) throw error('This hunt has an invalid model.');
  const selection = {
    modelId: requested.modelId,
    color: normalizeLabel(requested.color, 'color'),
    storage: normalizeLabel(requested.storage, 'storage', 12),
  };
  if (!/^\d+(?:\.\d+)?(?:GB|TB)$/.test(selection.storage)) throw error('This hunt has an invalid storage capacity.');
  const zip = typeof value.zip === 'string' ? value.zip.trim() : '';
  if (!/^\d{5}$/.test(zip)) throw error('A shared hunt needs a five-digit US ZIP code.');
  if (typeof value.watchAllNearby !== 'boolean') throw error('This hunt has an invalid store selection.');
  if (!Array.isArray(value.storeNumbers) || value.storeNumbers.length > 50 || value.storeNumbers.some(id => typeof id !== 'string' || !STORE_ID.test(id))) throw error('This hunt has an invalid store selection.');
  const storeNumbers = value.watchAllNearby ? [] : [...new Set(value.storeNumbers)].sort();
  if (!value.watchAllNearby && !storeNumbers.length) throw error('Choose at least one store before sharing this hunt.');
  const watchHours = value.watchHours ?? 24;
  if (!Number.isInteger(watchHours) || watchHours < 1 || watchHours > 72) throw error('This hunt has an invalid watch duration.');
  return { selection, zip, watchAllNearby: value.watchAllNearby, storeNumbers, watchHours };
}

function encode(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) throw error('This hunt is too large to share. Choose fewer stores.');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function decode(encoded) {
  if (!encoded || encoded.length > MAX_ENCODED_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) throw error('This hunt link is not valid.');
  let binary;
  try { binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4)); }
  catch { throw error('This hunt link is not valid.'); }
  if (binary.length > MAX_PAYLOAD_BYTES) throw error('This hunt link is too large.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)))); }
  catch { throw error('This hunt link is not valid.'); }
}

/** Only preferences are shared. No session, stock result, credential or completion data leaves the browser. */
export function createHuntLink(settings, origin) {
  let url;
  try { url = new URL(origin); } catch { throw error('A valid site address is required to share a hunt.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) throw error('Hunt links need a secure site address.');
  const link = new URL('/', url.origin);
  link.hash = `hunt=${encode({ v: 1, ...sharedSettings(settings) })}`;
  return link.href;
}

/** Returns null for ordinary URLs; malformed or obsolete hunt links throw a helpful error. */
export function readHuntInvite(hash, catalog) {
  if (typeof hash !== 'string' || !hash) return null;
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!fragment.startsWith('hunt=')) return null;
  const value = decode(fragment.slice(5));
  if (value?.v !== 1) throw error('This hunt link uses a version we do not recognize.');
  const settings = sharedSettings(value);
  const variants = (catalog?.models || []).flatMap(model => Array.isArray(model.variants) ? model.variants : []);
  const matches = variants.filter(variant => ['modelId', 'color', 'storage'].every(key => variant[key] === settings.selection[key]));
  if (matches.length !== 1) throw error('That exact phone is no longer in the current catalog. Choose a new configuration.');
  return settings;
}

const PALETTES = {
  'star white': ['#ece9df', '#b4b3aa', '#fcfaf1'],
  'cloud white': ['#eeeee8', '#b9beb9', '#ffffff'],
  white: ['#eeeee7', '#b5bcb5', '#ffffff'],
  silver: ['#c8cfcc', '#929c99', '#f4f6ef'],
  'night sky': ['#343b49', '#202734', '#697486'],
  'space black': ['#303431', '#1b221e', '#626d66'],
  black: ['#363a37', '#1d2520', '#647068'],
  burgundy: ['#804a57', '#512f3b', '#b87d89'],
  glacier: ['#b9d4dc', '#7d9fa9', '#e4f4f3'],
  'sky blue': ['#b9d0df', '#839eae', '#e4eff2'],
  'mist blue': ['#aabecf', '#718d9c', '#dce9ef'],
  'light gold': ['#dfcfad', '#aa9575', '#f8edd7'],
  lavender: ['#bfb3d5', '#8d7ca6', '#e8e0ee'],
  sage: ['#b1c1a7', '#7c9474', '#e5ecdb'],
  'soft pink': ['#e0bcc3', '#b88993', '#f6e0e2'],
  pink: ['#d99ba8', '#ad6979', '#f4d3d8'],
  ultramarine: ['#687daf', '#425b89', '#b0bce0'],
  teal: ['#75a8a6', '#477d7b', '#b8dbd3'],
};

/** Illustrative paint colors, not product photographs or an exact material preview. */
export function getPhonePalette(color) {
  const [body, edge, highlight] = PALETTES[String(color || '').trim().toLowerCase()] || ['#b7bdb2', '#7c877a', '#e6e9de'];
  return { body, edge, highlight, lens: '#202b2a', ink: '#26342d', paper: '#f6f3e9' };
}
const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

function phoneArt({ color, modelId = '', complete = false, idPrefix = 'hunt-phone' } = {}) {
  const p = getPhonePalette(color);
  const pro = /pro/i.test(String(modelId));
  const prefix = String(idPrefix).replace(/[^a-z0-9_-]/gi, '') || 'phone';
  const third = pro ? `<circle cx="116" cy="83" r="15" fill="${p.edge}"/><circle cx="116" cy="83" r="11" fill="${p.lens}"/><circle cx="112" cy="79" r="3" fill="#a6c2be" opacity=".65"/>` : `<circle cx="117" cy="71" r="4" fill="${p.highlight}"/>`;
  return `<defs><linearGradient id="${prefix}-paint" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${p.highlight}"/><stop offset=".4" stop-color="${p.body}"/><stop offset="1" stop-color="${p.edge}"/></linearGradient></defs>
<ellipse cx="137" cy="293" rx="79" ry="13" fill="#2d3c2f" opacity=".10"/>
<g transform="rotate(8 130 155)"><rect x="64" y="23" width="139" height="264" rx="27" fill="${p.edge}"/><rect x="68" y="27" width="131" height="256" rx="24" fill="url(#${prefix}-paint)"/><path d="M181 40v223" fill="none" stroke="${p.highlight}" stroke-width="2" opacity=".6"/>
<rect x="78" y="39" width="69" height="78" rx="20" fill="${p.body}" stroke="${p.edge}" stroke-width="1.5"/>
<circle cx="97" cy="61" r="15" fill="${p.edge}"/><circle cx="97" cy="61" r="11" fill="${p.lens}"/><circle cx="93" cy="57" r="3" fill="#a6c2be" opacity=".65"/>
<circle cx="97" cy="96" r="15" fill="${p.edge}"/><circle cx="97" cy="96" r="11" fill="${p.lens}"/><circle cx="93" cy="92" r="3" fill="#a6c2be" opacity=".65"/>${third}
<path d="M119 176l11-11 11 11-11 11z" fill="${p.highlight}" opacity=".8"/>
<path d="M63 87v28m0 13v18m141-37v41" fill="none" stroke="${p.edge}" stroke-width="3" stroke-linecap="round"/></g>
${complete ? '<g transform="translate(201 239)"><circle r="28" fill="#47684c" stroke="#f6f3e9" stroke-width="5"/><path d="m-11 0 7 8 16-18" fill="none" stroke="#f6f3e9" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></g>' : ''}`;
}

export function buildPhoneSVG({ color = '', modelId = '', complete = false } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 320" role="img" aria-label="${xml(color || 'Selected')} phone illustration"><title>${xml(color || 'Selected')} phone illustration</title>${phoneArt({color, modelId, complete})}</svg>`;
}

function wrap(text, maxLength = 35, maxLines = 2) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean), lines = [];
  let line = '';
  for (const word of words) {
    if (line && (line.length + word.length + 1 > maxLength)) { lines.push(line); line = word; }
    else line += `${line ? ' ' : ''}${word}`;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) return [...lines.slice(0, maxLines - 1), `${lines.slice(maxLines - 1).join(' ').slice(0, maxLength - 1).trim()}…`];
  return lines;
}

/** A shareable visitor-confirmed souvenir; it never represents a verified Apple order. */
export function buildVictorySVG(completion = {}) {
  const variant = completion.variant || {}, selection = completion.selection || {};
  const modelName = variant.modelName || variant.name || 'Your new iPhone';
  const color = variant.color || selection.color || '';
  const storage = variant.storage || selection.storage || '';
  const titleLines = wrap(modelName, 33, 2);
  const subtitle = [color, storage].filter(Boolean).join(' · ');
  const store = completion.storeName || 'Pickup complete';
  let completedDate = '';
  const date = new Date(completion.completedAt);
  if (completion.completedAt && Number.isFinite(date.getTime())) completedDate = new Intl.DateTimeFormat('en-US', {year:'numeric', month:'short', day:'numeric',timeZone:'UTC'}).format(date);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700" viewBox="0 0 1200 700" role="img" aria-label="Visitor-confirmed Pickup Hunt success card">
<title>Mission complete — ${xml(modelName)}</title><desc>A souvenir confirmed by the hunter. This card is not an Apple order confirmation.</desc>
<rect width="1200" height="700" rx="28" fill="#f6f3e9"/><rect x="18" y="18" width="1164" height="664" rx="18" fill="none" stroke="#d8d8c8"/>
<g fill="#26342d" font-family="system-ui, -apple-system, Segoe UI, sans-serif"><text x="65" y="72" font-size="24" font-weight="750" letter-spacing="-1">pickup hunt</text><text x="1135" y="69" text-anchor="end" font-size="12" font-weight="650" letter-spacing="2.3">A LITTLE HUNT. A HAPPY ENDING.</text>
<text x="65" y="200" font-size="76" font-weight="750" letter-spacing="-4">Mission</text><text x="65" y="284" font-size="76" font-weight="750" letter-spacing="-4" fill="#b65f3e">complete.</text>
${titleLines.map((line, index) => `<text x="68" y="${361 + index * 39}" font-size="32" font-weight="600" letter-spacing="-.8">${xml(line)}</text>`).join('')}
<text x="68" y="${titleLines.length > 1 ? 437 : 406}" font-size="23" fill="#647060">${xml(subtitle)}</text>
<path d="M68 469h620" stroke="#d8d8c8"/><text x="68" y="509" font-size="25" font-weight="600">${xml(wrap(store, 43, 1)[0])}</text>
<text x="68" y="547" font-size="17" fill="#647060">Confirmed by the hunter${completedDate ? ` · ${xml(completedDate)}` : ''}</text>
<text x="68" y="633" font-size="14" fill="#647060">Your phone. Your stores. Your mission, complete.</text></g>
<circle cx="947" cy="354" r="170" fill="#e9e9d9"/><circle cx="947" cy="354" r="190" fill="none" stroke="#d3d9c5" stroke-dasharray="3 11"/>
<svg x="787" y="146" width="324" height="398" viewBox="0 0 260 320">${phoneArt({color,modelId:variant.modelId || selection.modelId,complete:true,idPrefix:'victory-phone'})}</svg>
<path d="m799 155 4 12 13 4-13 4-4 13-4-13-12-4 12-4zm298 349 3 10 10 3-10 3-3 10-3-10-10-3 10-3z" fill="#b65f3e"/>
</svg>`;
}
