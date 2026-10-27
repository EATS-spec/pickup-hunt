export const CATALOG_URL = 'https://www.apple.com/shop/buy-iphone';
export const CATALOG_TTL_MS = 24 * 60 * 60_000;
const RETRY_DELAY_MS = 5 * 60_000;
const MAX_HTML_BYTES = 8 * 1024 * 1024;

export class CatalogError extends Error {
  constructor(message) { super(message); this.name = 'CatalogError'; }
}

function plainText(value) {
  return String(value ?? '')
    .replace(/<as-footnote\b[^>]*>[\s\S]*?<\/as-footnote>/gi, '')
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, code) => {
      const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, entity) => ({
      nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
    })[entity.toLowerCase()])
    .replace(/\s+/g, ' ').trim();
}

function normalize(value) { return plainText(value).toLowerCase().replace(/\s+/g, ''); }
function requireValue(condition, message) { if (!condition) throw new CatalogError(message); }

// Read only links Apple actually publishes on its US shopping landing page.
// No SKU combinations or family paths are manufactured by this discovery step.
export function discoverFamilyPages(html) {
  requireValue(typeof html === 'string', 'Apple landing page is not HTML.');
  const urls = new Set();
  for (const anchor of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gis)) {
    let url;
    try { url = new URL(plainText(anchor[2]), CATALOG_URL); } catch { continue; }
    if (url.origin !== 'https://www.apple.com' || !/^\/shop\/buy-iphone\/iphone[a-z0-9-]*\/?$/.test(url.pathname)) continue;
    url.search = ''; url.hash = ''; url.pathname = url.pathname.replace(/\/$/, '');
    urls.add(url.href);
  }
  requireValue(urls.size > 0, 'Apple landing page has no recognizable iPhone family links.');
  return [...urls];
}

// The bootstrap contains JSON inside a JavaScript assignment. Extract balanced
// JSON without evaluating any script from Apple (or from a test fixture).
export function extractProductSelection(html) {
  requireValue(typeof html === 'string', 'Apple family page is not HTML.');
  const marker = html.indexOf('window.PRODUCT_SELECTION_BOOTSTRAP');
  requireValue(marker >= 0, 'Apple page is missing PRODUCT_SELECTION_BOOTSTRAP.');
  const scriptEnd = html.indexOf('</script', marker);
  const script = html.slice(marker, scriptEnd < 0 ? undefined : scriptEnd);
  const key = /["']?productSelectionData["']?\s*:\s*/.exec(script);
  requireValue(key, 'Apple bootstrap is missing productSelectionData.');
  const start = key.index + key[0].length;
  requireValue(script[start] === '{', 'Apple productSelectionData has an unknown schema.');
  let depth = 0; let quoted = false; let escaped = false;
  for (let i = start; i < script.length; i++) {
    const c = script[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(script.slice(start, i + 1)); }
      catch { throw new CatalogError('Apple productSelectionData is not valid JSON.'); }
    }
  }
  throw new CatalogError('Apple productSelectionData is incomplete.');
}

function modelNameFor(product, data, html, familyCount) {
  const screenLabel = data.displayValues.dimensionScreensize?.[product.dimensionScreensize]?.value;
  if (typeof screenLabel === 'string') {
    const name = plainText(screenLabel.split(/<span\b/i)[0]);
    requireValue(/^iPhone\b/.test(name), 'Apple screen label is missing its model name.');
    return name;
  }
  requireValue(!product.dimensionScreensize && familyCount === 1, 'Apple model names cannot be disambiguated.');
  const title = plainText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
  const match = /^(?:Shop|Buy) (iPhone.+?) - Apple$/.exec(title);
  requireValue(match && !/ and iPhone/.test(match[1]), 'Apple page title is missing a single model name.');
  return match[1];
}

function storageFor(product) {
  const inToken = /(?:^|-)(\d+(?:\.\d+)?)(gb|tb)(?:-|$)/i.exec(product.seoUrlToken);
  const explicit = product.dimensionCapacity == null ? null : /^(\d+(?:\.\d+)?)(gb|tb)$/i.exec(product.dimensionCapacity);
  requireValue(inToken && (product.dimensionCapacity == null || explicit), 'Apple variant has an unknown storage capacity.');
  const format = match => `${match[1]}${match[2].toUpperCase()}`;
  requireValue(!explicit || format(explicit) === format(inToken), 'Apple capacity and checkout URL disagree.');
  // iPhone 16 has no dimensionCapacity field; its native URL token specifies 128gb.
  return format(explicit || inToken);
}

function carrierPriority(product) {
  return product.carrierModel === 'UNLOCKED/US' || product.carrierPolicyType === 'UNLOCKED' ? 0 : 1;
}

function rankIn(values, key) {
  const order = values?.variantOrder;
  const rank = Array.isArray(order) ? order.indexOf(key) : -1;
  return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
}

// Every product row must be recognized. Dropping malformed rows would turn a
// schema change or truncated response into a deceptively complete catalog.
export function parseFamilyPage(html, pageUrl) {
  const url = new URL(pageUrl);
  requireValue(url.origin === 'https://www.apple.com' && /^\/shop\/buy-iphone\/iphone[a-z0-9-]+$/.test(url.pathname), 'Catalog source must be an official US iPhone family page.');
  const data = extractProductSelection(html);
  requireValue(Array.isArray(data.products) && data.products.length > 0 && data.displayValues && typeof data.displayValues === 'object', 'Apple product selection schema is missing variants or display values.');
  const families = new Set(data.products.map(product => product?.familyType));
  const models = new Map(); const parts = new Map(); const choices = new Map();
  const seenColors = new Set(); const seenCapacities = new Set();
  for (const product of data.products) {
    requireValue(product && /^[a-z][a-z0-9]*$/.test(product.familyType || '') && /^[A-Z0-9]{6,8}\/A$/.test(product.partNumber || '') && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(product.seoUrlToken || ''), 'Apple variant is missing a recognizable native family, part number, or checkout token.');
    const color = plainText(data.displayValues.dimensionColor?.[product.dimensionColor]?.value);
    requireValue(color && typeof product.dimensionColor === 'string', 'Apple variant is missing its official color label.');
    const modelName = modelNameFor(product, data, html, families.size);
    const storage = storageFor(product);
    const modelId = product.familyType;
    const key = `${modelId}|${normalize(color)}|${normalize(storage)}`;
    const previousKey = parts.get(product.partNumber);
    requireValue(!previousKey || previousKey === key, 'Apple assigns one part number to conflicting configurations.');
    parts.set(product.partNumber, key);
    const previous = choices.get(key);
    requireValue(!previous || previous.variant.partNumber === product.partNumber, 'Apple lists different physical parts for the same selection; carrier choice is required.');
    if (!models.has(modelId)) models.set(modelId, { id: modelId, name: modelName, colors: [], storages: [], variants: [], rank: rankIn(data.displayValues.dimensionScreensize, product.dimensionScreensize) });
    requireValue(models.get(modelId).name === modelName, 'Apple model ID has conflicting names.');
    const variant = { partNumber: product.partNumber, modelId, modelName, color, storage,
      name: `${modelName} ${storage} ${color}`, checkoutUrl: `${url.href}/${product.seoUrlToken}` };
    if (!previous || carrierPriority(product) < previous.priority) choices.set(key, { variant, priority: carrierPriority(product), colorKey: product.dimensionColor, capacityKey: product.dimensionCapacity });
    seenColors.add(product.dimensionColor);
    if (product.dimensionCapacity != null) seenCapacities.add(product.dimensionCapacity);
  }
  for (const [dimension, seen] of [['dimensionColor', seenColors], ['dimensionCapacity', seenCapacities]]) {
    const order = data.displayValues[dimension]?.variantOrder;
    requireValue(!order || (Array.isArray(order) && order.every(key => seen.has(key))), `Apple ${dimension} choices are only partially represented in product data.`);
  }
  for (const choice of [...choices.values()].sort((a, b) => rankIn(data.displayValues.dimensionColor, a.colorKey) - rankIn(data.displayValues.dimensionColor, b.colorKey)
    || rankIn(data.displayValues.dimensionCapacity, a.capacityKey) - rankIn(data.displayValues.dimensionCapacity, b.capacityKey)
    || a.variant.storage.localeCompare(b.variant.storage, 'en', { numeric: true }))) {
    const model = models.get(choice.variant.modelId);
    model.variants.push(choice.variant);
    if (!model.colors.includes(choice.variant.color)) model.colors.push(choice.variant.color);
    if (!model.storages.includes(choice.variant.storage)) model.storages.push(choice.variant.storage);
  }
  return [...models.values()].sort((a, b) => a.rank - b.rank).map(({ rank, ...model }) => model);
}

export function validateCachedCatalog(value) {
  requireValue(value?.version === 1 && value.source === CATALOG_URL && Number.isFinite(Date.parse(value.updatedAt)) && Array.isArray(value.pages) && value.pages.length > 0 && Array.isArray(value.models) && value.models.length > 0, 'Saved Apple catalog has an unknown schema.');
  const modelIds = new Set(); const keys = new Set();
  for (const model of value.models) {
    requireValue(typeof model.id === 'string' && !modelIds.has(model.id) && typeof model.name === 'string' && Array.isArray(model.colors) && Array.isArray(model.storages) && Array.isArray(model.variants) && model.variants.length > 0, 'Saved Apple catalog is incomplete.');
    modelIds.add(model.id);
    for (const variant of model.variants) {
      const key = `${model.id}|${normalize(variant.color)}|${normalize(variant.storage)}`;
      let url; try { url = new URL(variant.checkoutUrl); } catch { /* reject below */ }
      requireValue(!keys.has(key) && variant.modelId === model.id && variant.modelName === model.name && /^[A-Z0-9]{6,8}\/A$/.test(variant.partNumber || '') && model.colors.includes(variant.color) && model.storages.includes(variant.storage) && typeof variant.name === 'string' && url?.origin === 'https://www.apple.com' && url.pathname.startsWith('/shop/buy-iphone/iphone'), 'Saved Apple catalog contains an invalid variant.');
      keys.add(key);
    }
    requireValue(model.colors.every(color => model.variants.some(variant => variant.color === color)) && model.storages.every(storage => model.variants.some(variant => variant.storage === storage)), 'Saved Apple catalog contains empty choices.');
  }
  const coveredIds = new Set();
  for (const page of value.pages) {
    requireValue(typeof page.url === 'string' && discoverFamilyPages(`<a href="${page.url}"></a>`)[0] === page.url && Array.isArray(page.modelIds) && page.modelIds.length > 0 && page.modelIds.every(id => modelIds.has(id) && !coveredIds.has(id)), 'Saved Apple catalog is missing source coverage.');
    page.modelIds.forEach(id => coveredIds.add(id));
  }
  requireValue(coveredIds.size === modelIds.size, 'Saved Apple catalog is missing model source coverage.');
  return value;
}

function snapshotOf(catalog, stale = false, error) {
  return { updatedAt: catalog.updatedAt, stale, source: catalog.source, models: structuredClone(catalog.models), ...(error ? { error } : {}) };
}

function initialFallback(error) {
  const variant = { partNumber: 'MJWA4LL/A', modelId: 'iphone18promax', modelName: 'iPhone 18 Pro Max', color: 'Burgundy', storage: '512GB', name: 'iPhone 18 Pro Max 512GB Burgundy', checkoutUrl: 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.9-inch-display-512gb-burgundy-unlocked' };
  return { updatedAt: null, stale: true, source: 'verified-official-fallback', error: `${error} Only the previously verified Burgundy 512GB Pro Max is available; the full catalog has not loaded.`, models: [{ id: variant.modelId, name: variant.modelName, colors: [variant.color], storages: [variant.storage], variants: [variant] }] };
}
