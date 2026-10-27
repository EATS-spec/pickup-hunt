export const WATCH_HOURS = [1, 4, 12, 24, 72];

const unique = values => [...new Set(values)];
const stores = values => unique((values || []).filter(value => typeof value === 'string')).sort();

export function selectionOptions(catalog, requested = {}) {
  const models = (catalog?.models || []).filter(model => model.variants?.length);
  const model = models.find(item => item.id === requested.modelId) || models[0];
  if (!model) return { models, colors: [], storages: [], selection: {}, variant: null };
  const colors = unique(model.variants.map(variant => variant.color));
  const color = colors.includes(requested.color) ? requested.color : colors[0];
  const matching = model.variants.filter(variant => variant.color === color);
  const storages = unique(matching.map(variant => variant.storage));
  const storage = storages.includes(requested.storage) ? requested.storage : storages[0];
  const selection = { modelId: model.id, color, storage };
  return { models, colors, storages, selection, variant: matching.find(variant => variant.storage === storage) || null };
}

export function draftFromConfig(config = {}, catalog) {
  const model = config.models?.[0];
  const requested = config.selection || { modelId: model?.modelId, color: model?.color, storage: model?.storage };
  return {
    selection: catalog ? selectionOptions(catalog, requested).selection : { ...requested },
    zip: String(config.zip || ''),
    watchAllNearby: config.watchAllNearby !== false,
    storeNumbers: stores(config.storeNumbers),
    watchHours: WATCH_HOURS.includes(Number(config.watchHours)) ? Number(config.watchHours) : 24,
  };
}

export function reconcileDraft(draft, config, catalog, { force = false } = {}) {
  return draft && !force ? draft : draftFromConfig(config, catalog);
}

export function updateDraft(draft, changes, catalog) {
  const next = { ...draft, ...changes, selection: { ...draft.selection, ...changes.selection } };
  next.selection = selectionOptions(catalog, next.selection).selection;
  next.storeNumbers = stores(next.storeNumbers);
  if (Object.hasOwn(changes, 'zip') && String(changes.zip).trim() !== String(draft.zip).trim()) {
    next.watchAllNearby = true;
    next.storeNumbers = [];
  }
  return next;
}

function comparable(settings) {
  return JSON.stringify({
    selection: {
      modelId: settings.selection?.modelId || '', color: settings.selection?.color || '', storage: settings.selection?.storage || '',
    },
    zip: String(settings.zip || '').trim(), watchAllNearby: settings.watchAllNearby !== false,
    storeNumbers: settings.watchAllNearby !== false ? [] : stores(settings.storeNumbers), watchHours: Number(settings.watchHours || 24),
  });
}

export function draftIsDirty(draft, config) {
  return !!draft && comparable(draft) !== comparable(draftFromConfig(config));
}

export function settingsPayload(draft, catalog) {
  const options = selectionOptions(catalog, draft?.selection);
  if (!options.variant || ['modelId', 'color', 'storage'].some(key => options.selection[key] !== draft?.selection?.[key])) {
    throw new Error('Choose a valid model, color, and storage combination.');
  }
  const zip = String(draft.zip || '').trim();
  if (!/^\d{5}$/.test(zip)) throw new Error('Enter a five-digit US ZIP code.');
  const watchHours = Number(draft.watchHours);
  if (!WATCH_HOURS.includes(watchHours)) throw new Error('Choose a watch duration.');
  const storeNumbers = draft.watchAllNearby ? [] : stores(draft.storeNumbers);
  if (!draft.watchAllNearby && !storeNumbers.length) throw new Error('Choose at least one store or watch all nearby stores.');
  return { selection: { ...options.selection }, zip, watchAllNearby: !!draft.watchAllNearby, storeNumbers, watchHours };
}

export function isWatchedStore(storeNumber, settings = {}) {
  return settings.watchAllNearby !== false || (settings.storeNumbers || []).includes(storeNumber);
}

export function filterWatchedRows(rows, config = {}) {
  const parts = new Set((config.models || []).map(model => model.partNumber));
  return (rows || []).filter(row => row && parts.has(row.partNumber) && isWatchedStore(row.storeNumber, config));
}
