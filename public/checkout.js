const APPLE_BASE_URL = 'https://www.apple.com/shop/buy-iphone';

export function configuredCheckoutURL(partNumber, models = []) {
  const model = models.find(item => item.partNumber === partNumber);
  try {
    const url = new URL(model?.checkoutUrl);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname === 'apple.com' || url.hostname.endsWith('.apple.com'))
      ? url.href : APPLE_BASE_URL;
  } catch { return APPLE_BASE_URL; }
}

export function selectCurrentAlert(notifications = [], observations = [], knownIds = []) {
  const known = new Set(knownIds);
  const available = new Set(observations
    .filter(row => row && !row.stale && row.availability === 'available'
      && typeof row.storeNumber === 'string' && typeof row.partNumber === 'string')
    .map(row => `${row.storeNumber}|${row.partNumber}`));
  const newIds = [];
  let shouldChime = false;
  for (const note of notifications) {
    if (!note || typeof note.id !== 'string' || known.has(note.id)) continue;
    known.add(note.id);
    newIds.push(note.id);
    if (typeof note.storeNumber === 'string' && typeof note.partNumber === 'string'
      && available.has(`${note.storeNumber}|${note.partNumber}`)) shouldChime = true;
  }
  return { newIds, shouldChime };
}
