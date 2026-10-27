export const MODELS = [{
  partNumber: 'MJWA4LL/A',
  name: 'iPhone 18 Pro Max 512GB Burgundy',
  preferred: true,
  checkoutUrl: 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.9-inch-display-512gb-burgundy-unlocked',
}];

// Public city-center ZIP anchors. Apple decides which nearby stores each query returns;
// this is a rotation across those regions, not proof of exhaustive national coverage.
const anchor = (zip, city, timeZone = 'America/New_York') => ({ zip, city, timeZone });
export const NEARBY = anchor('10001', 'New York, NY');
const northeast = [NEARBY, anchor('07030', 'Hoboken, NJ'),
  anchor('06510', 'New Haven, CT'), anchor('02108', 'Boston, MA'),
  anchor('19103', 'Philadelphia, PA'), anchor('20001', 'Washington, DC')];
const national = [...northeast, anchor('30303', 'Atlanta, GA'), anchor('33130', 'Miami, FL'),
  anchor('60601', 'Chicago, IL', 'America/Chicago'), anchor('75201', 'Dallas, TX', 'America/Chicago'),
  anchor('77002', 'Houston, TX', 'America/Chicago'), anchor('80202', 'Denver, CO', 'America/Denver'),
  anchor('85004', 'Phoenix, AZ', 'America/Phoenix'), anchor('89101', 'Las Vegas, NV', 'America/Los_Angeles'),
  anchor('90012', 'Los Angeles, CA', 'America/Los_Angeles'), anchor('92101', 'San Diego, CA', 'America/Los_Angeles'),
  anchor('94102', 'San Francisco, CA', 'America/Los_Angeles'), anchor('98101', 'Seattle, WA', 'America/Los_Angeles'),
  anchor('97204', 'Portland, OR', 'America/Los_Angeles'), anchor('96813', 'Honolulu, HI', 'Pacific/Honolulu'),
  anchor('99501', 'Anchorage, AK', 'America/Anchorage')];
export const SCOPES = [
  { id: 'nearby', label: 'Example nearby region', anchors: [NEARBY] },
  { id: 'northeast', label: 'Northeast', anchors: northeast },
  { id: 'national', label: 'US city rotation', anchors: national },
];
export function createConfig({ variant = MODELS[0], selection = { modelId: 'iphone18promax', color: 'Burgundy', storage: '512GB' }, zip = '10001', watchAllNearby = true, storeNumbers = [], watchHours = 24 } = {}) {
  return {
    profileId: `${variant.partNumber}|${zip}`, title: 'Pickup Hunt',
    headline: 'Find your next iPhone.', subhead: variant.name,
    checkoutLabel: 'Continue at Apple',
    checkoutNote: 'Choose your carrier and payment method at Apple, select the matched store, and confirm the pickup date before ordering.',
    selection: { ...selection }, zip, watchAllNearby, storeNumbers: [...storeNumbers], watchHours,
    preferredPart: variant.partNumber, models: [{ ...variant, preferred: true }],
    scopes: [{ id: 'nearby', label: `Near ${zip}`, anchors: [anchor(zip, `ZIP ${zip}`)] }],
    minimumGapSeconds: 240,
    onlinePickupNote: 'An alert does not reserve a phone. Confirm the pickup date and complete checkout at Apple. Online pickup and walk-in stock may differ.',
    coverageNote: 'Apple returns stores near your ZIP. Choose which returned stores to watch; this is not exhaustive regional coverage.',
    sourceNote: 'Read-only Apple storefront pickup endpoint. This undocumented interface can change or throttle requests.',
  };
}
export const CONFIG = createConfig();
export function validateSettings(input, { config = CONFIG, resolveSelection, knownStoreNumbers = [] } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InventoryError('Settings must be an object.', { kind: 'input' });
  const selection = input.selection ?? config.selection;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new InventoryError('Choose a model, color, and storage.', { kind: 'input' });
  let variant;
  try {
    variant = resolveSelection ? resolveSelection(selection) : config.models.find(item =>
      selection.modelId === config.selection.modelId && selection.color === config.selection.color && selection.storage === config.selection.storage);
  } catch (error) { throw new InventoryError(error.message, { kind: 'input' }); }
  if (!variant) throw new InventoryError('This configuration is not in the current Apple catalog.', { kind: 'input' });
  const zip = String(input.zip ?? config.zip).trim();
  if (!/^\d{5}$/.test(zip)) throw new InventoryError('Enter a five-digit US ZIP code.', { kind: 'input' });
  const changedZIP = zip !== config.zip;
  const watchAllNearby = input.watchAllNearby ?? (changedZIP ? true : config.watchAllNearby);
  if (typeof watchAllNearby !== 'boolean') throw new InventoryError('Choose all nearby stores or selected stores.', { kind: 'input' });
  const stores = input.storeNumbers ?? (changedZIP ? [] : config.storeNumbers);
  if (!Array.isArray(stores) || stores.length > 100 || stores.some(id => typeof id !== 'string' || !/^R\d{1,6}$/.test(id))) throw new InventoryError('Choose valid stores from the latest search.', { kind: 'input' });
  const storeNumbers = watchAllNearby ? [] : [...new Set(stores)];
  if (!watchAllNearby && (!storeNumbers.length || changedZIP || storeNumbers.some(id => !knownStoreNumbers.includes(id)))) throw new InventoryError('Search this ZIP first, then choose at least one returned store.', { kind: 'input' });
  const watchHours = input.watchHours ?? config.watchHours;
  if (!Number.isInteger(watchHours) || watchHours < 1 || watchHours > 72) throw new InventoryError('Watch duration must be between 1 and 72 hours.', { kind: 'input' });
  return createConfig({ variant, selection: { modelId: variant.modelId ?? selection.modelId, color: variant.color ?? selection.color, storage: variant.storage ?? selection.storage }, zip, watchAllNearby, storeNumbers, watchHours });
}
export const MIN_GAP_MS = 240_000;
export const WINDOW_MS = 94 * 60_000;
export const MAX_REQUESTS = 30;

export class InventoryError extends Error {
  constructor(message, { statusCode = null, kind = 'response' } = {}) {
    super(message); this.name = 'InventoryError'; this.statusCode = statusCode; this.kind = kind;
  }
}

export function scopeFor(id) {
  const found = SCOPES.find(scope => scope.id === id);
  if (!found) throw new InventoryError('Choose nearby, northeast, or national.', { kind: 'input' });
  return found;
}

export function buildInventoryURL(zip, models = MODELS) {
  const url = new URL('https://www.apple.com/shop/retail/pickup-message');
  url.searchParams.set('pl', 'true');
  url.searchParams.set('location', zip);
  models.forEach((model, index) => url.searchParams.set(`parts.${index}`, model.partNumber));
  return url;
}

function localDate(timestamp, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
}

// Use store-provided zones when present, otherwise state-specific zones only where
// unambiguous. For split-zone states we deliberately leave relative dates unverified.
const ZONES = {
  NY: 'America/New_York', NJ: 'America/New_York', CT: 'America/New_York', MA: 'America/New_York',
  PA: 'America/New_York', DC: 'America/New_York', DE: 'America/New_York', MD: 'America/New_York',
  VA: 'America/New_York', WV: 'America/New_York', NC: 'America/New_York', SC: 'America/New_York',
  GA: 'America/New_York', NH: 'America/New_York', VT: 'America/New_York', ME: 'America/New_York',
  OH: 'America/New_York', WI: 'America/Chicago', IL: 'America/Chicago', MN: 'America/Chicago',
  IA: 'America/Chicago', MO: 'America/Chicago', AR: 'America/Chicago', LA: 'America/Chicago',
  MS: 'America/Chicago', AL: 'America/Chicago', OK: 'America/Chicago',
  CO: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver', MT: 'America/Denver',
  AZ: 'America/Phoenix', CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  HI: 'Pacific/Honolulu',
};

function storeTimeZone(store) {
  const candidate = store.timeZone || store.timezone || store.storeTimeZone || store.retailStore?.timeZone || store.retailStore?.timezone;
  if (typeof candidate === 'string') {
    try { localDate(Date.now(), candidate); return candidate; } catch { /* unknown zone */ }
  }
  return ZONES[store.state] || null;
}

function safeDate(year, month, day) {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
  return value.toISOString().slice(0, 10);
}

export function classifyPickupDate(quote, { observedAt = new Date().toISOString(), timeZone = null, targetDate = localDate(observedAt, timeZone || 'America/New_York') } = {}) {
  const text = String(quote || '').replace(/<[^>]*>/g, ' ').replace(/\u00a0/g, ' ').trim();
  let pickupDate = null;
  let evidence = null;
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) { pickupDate = safeDate(+iso[1], +iso[2], +iso[3]); evidence = 'explicit-date'; }
  const year = Number((timeZone ? localDate(observedAt, timeZone) : observedAt).slice(0, 4));
  if (!pickupDate) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const spelled = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/i);
    if (spelled) {
      pickupDate = safeDate(spelled[3] ? +spelled[3] : year, months.indexOf(spelled[1].slice(0, 3).toLowerCase()) + 1, +spelled[2]);
      evidence = 'explicit-date';
    }
  }
  if (!pickupDate) {
    const numeric = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/);
    if (numeric) { pickupDate = safeDate(numeric[3] ? +numeric[3] : year, +numeric[1], +numeric[2]); evidence = 'explicit-date'; }
  }
  if (!pickupDate && /\btoday\b/i.test(text) && timeZone) {
    pickupDate = localDate(observedAt, timeZone); evidence = 'today-in-store-time-zone';
  }
  if (!pickupDate && /\btomorrow\b/i.test(text) && timeZone) {
    const today = localDate(observedAt, timeZone);
    pickupDate = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    evidence = 'tomorrow-in-store-time-zone';
  }
  // A generic availableNow, shipping quote, weekday alone, or check-back message
  // never verifies the target pickup date. Relative quotes require a known store zone.
  return { pickupDate, targetDateStatus: !pickupDate ? 'date-unverified' : pickupDate === targetDate ? 'verified' : 'other-date', dateEvidence: pickupDate ? evidence : null };
}

function quoteFor(part) {
  const regular = part.messageTypes?.regular;
  const values = [regular?.storePickupQuote, regular?.storePickupSearchQuote,
    part.pickupQuote, part.pickupSearchQuote, part.storePickupQuote, part.storePickupSearchQuote];
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()))].join(' · ');
}

export function parseInventory(payload, { anchor: checkedAnchor = NEARBY, observedAt = new Date().toISOString(), models = MODELS, targetDate = null } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new InventoryError('Apple returned an invalid response.');
  const body = payload.body;
  if (!body || typeof body !== 'object') throw new InventoryError('Apple response is missing its body.');
  const stores = body.stores ?? body.content?.pickupMessage?.stores;
  if (!Array.isArray(stores) || stores.length === 0) {
    throw new InventoryError(typeof body.errorMessage === 'string' ? `Apple: ${body.errorMessage}` : 'Apple returned no stores; this is an incomplete check.');
  }
  const observations = [];
  const warnings = [];
  let recognizedParts = 0;
  for (const store of stores) {
    if (!store || typeof store.storeNumber !== 'string' || typeof store.storeName !== 'string' || !store.partsAvailability || typeof store.partsAvailability !== 'object' || Array.isArray(store.partsAvailability)) {
      warnings.push('One returned store has an unexpected schema.'); continue;
    }
    const timeZone = storeTimeZone(store);
    const hours = store.storeHours ?? store.retailStore?.storeHours ?? null;
    const regularHours = hours?.hours ?? store.regularHours ?? store.retailStore?.regularHours ?? null;
    const specialHours = store.specialHours ?? store.storeHolidays ?? hours?.specialHours
      ?? store.retailStore?.specialHours ?? store.retailStore?.storeHolidays ?? null;
    for (const model of models) {
      const part = store.partsAvailability[model.partNumber] ?? Object.values(store.partsAvailability).find(item => item?.partNumber === model.partNumber);
      const recognized = part && part.partNumber === model.partNumber && ['available', 'unavailable', 'ineligible', 'default'].includes(part.pickupDisplay);
      if (recognized) recognizedParts++;
      const availability = !recognized ? 'unknown' : part.pickupDisplay === 'available' ? 'available' : part.pickupDisplay === 'default' ? 'unavailable' : part.pickupDisplay;
      const pickupQuote = part ? quoteFor(part) : '';
      const dates = availability === 'available' ? classifyPickupDate(pickupQuote, { observedAt, timeZone, ...(targetDate ? { targetDate } : {}) }) : { pickupDate: null, targetDateStatus: 'date-unverified', dateEvidence: null };
      observations.push({
        id: `${store.storeNumber}|${model.partNumber}`, storeNumber: store.storeNumber,
        storeName: store.storeName, city: store.city || '', state: store.state || '', timeZone,
        storeHours: hours, regularHours, specialHours,
        anchor: checkedAnchor.zip, distanceFromAnchorMiles: Number.isFinite(Number(store.storedistance)) ? Number(store.storedistance) : null, observedAt, partNumber: model.partNumber, partName: model.name,
        preferred: model.preferred, availability, pickupQuote, ...dates,
        stale: !recognized, staleReason: recognized ? null : 'Missing or unknown availability in Apple response.',
        productUrl: `https://www.apple.com/shop/product/${model.partNumber}`,
      });
    }
  }
  if (!observations.length || !recognizedParts) throw new InventoryError('Apple returned no recognizable product availability; this is an incomplete check.');
  if (observations.some(row => row.availability === 'unknown')) warnings.push('Some product availability was missing or unknown.');
  return { observations, warnings, storeCount: new Set(observations.map(row => row.storeNumber)).size };
}

export class RequestGate {
  constructor({ requestTimes = [], failureCount = 0, backoffUntil = 0 } = {}) {
    this.requestTimes = requestTimes.filter(Number.isFinite);
    this.failureCount = failureCount;
    this.backoffUntil = backoffUntil;
  }
  prune(now) { this.requestTimes = this.requestTimes.filter(time => time > now - WINDOW_MS); }
  nextAllowed(now = Date.now()) {
    this.prune(now);
    const last = this.requestTimes.at(-1);
    return Math.max(now, last == null ? now : last + MIN_GAP_MS,
      this.requestTimes.length >= MAX_REQUESTS ? this.requestTimes[this.requestTimes.length - MAX_REQUESTS] + WINDOW_MS + 1 : now,
      this.backoffUntil);
  }
  reserve(now = Date.now()) {
    if (this.nextAllowed(now) > now) return false;
    this.requestTimes.push(now); return true;
  }
  throttle(now = Date.now()) {
    this.failureCount++;
    const minutes = Math.min(60, 10 * (2 ** Math.min(this.failureCount - 1, 3)));
    this.backoffUntil = now + minutes * 60_000; return minutes;
  }
  success() { this.failureCount = 0; this.backoffUntil = 0; }
  serialize() { return { requestTimes: this.requestTimes, failureCount: this.failureCount, backoffUntil: this.backoffUntil }; }
}

export function mergeObservations(previous, incoming, activeKeys, now = new Date().toISOString()) {
  const rows = new Map(previous.map(row => [row.id, row]));
  const keys = new Set(activeKeys);
  const notifications = [];
  for (const row of incoming) {
    const prior = rows.get(row.id);
    if (row.availability === 'unknown' && prior) {
      rows.set(row.id, { ...prior, stale: true, staleReason: row.staleReason, lastAttemptAt: row.observedAt });
      continue;
    }
    rows.set(row.id, row);
    if (row.availability === 'available') {
      const launchDateConfirmed = row.targetDateStatus === 'verified' && prior?.targetDateStatus !== 'verified';
      if (!keys.has(row.id) || launchDateConfirmed) notifications.push({ id: `${row.id}|${now}`, createdAt: now, storeNumber: row.storeNumber,
        storeName: row.storeName, partNumber: row.partNumber, partName: row.partName, preferred: row.preferred,
        targetDateStatus: row.targetDateStatus, pickupDate: row.pickupDate, productUrl: row.productUrl });
      keys.add(row.id);
    } else keys.delete(row.id);
  }
  return { observations: [...rows.values()], activeKeys: [...keys], notifications };
}
