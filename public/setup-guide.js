/** A next step for the previewed hunt, never a claim about another saved target. */
export function setupGuide({state, draft, variant, dirty = false, busy = false, disconnected = false} = {}) {
  const zip = String(draft?.zip || '').trim();
  const ready = !!variant && /^\d{5}$/.test(zip);
  const saved = state?.config || {};
  const sameTarget = ready && zip === saved.zip && variant.partNumber === saved.models?.[0]?.partNumber;
  const stores = sameTarget ? state?.stores || [] : [];
  const selectedCount = draft?.watchAllNearby === false ? draft.storeNumbers?.length || 0 : stores.length;
  const hasStores = stores.length > 0;
  const active = !!state?.monitor?.enabled && sameTarget && !dirty;
  let step = ready && sameTarget && hasStores ? 2 : 0;
  let heading = 'First, pick your phone and ZIP.';
  let description = 'Then find nearby Apple Stores and choose where you would pick it up.';
  if (ready) {
    heading = sameTarget && hasStores ? 'Your stores are ready. Make it a watch.' : 'Find your stores and take a first look.';
    description = sameTarget && hasStores
      ? `${stores.length} nearby store${stores.length === 1 ? '' : 's'} found. ${draft.watchAllNearby !== false ? 'Keep all nearby stores or choose a few favorites.' : selectedCount ? `${selectedCount} selected. Start your watch when you’re ready.` : 'Choose at least one store, or switch to all nearby stores.'}`
      : 'Find stores & check stock is a one-time check. Start a watch afterward for automatic cloud checks.';
  }
  if (ready && sameTarget && !hasStores && (state?.scheduler?.queuedScope || state?.scheduler?.inFlight)) {
    step = 1; heading = 'Your first look is on its way.';
    description = 'Nearby stores will appear after Apple responds. You can also start a watch for all nearby stores while your check waits.';
  }
  if (active) {
    step = 3; heading = 'You’re on the lookout.';
    description = 'Your cloud watch is running. Enable notifications below for a heads-up with this page closed.';
  }
  if (state?.completion && !dirty) {
    step = 3; heading = 'A good find, safely in the books.';
    description = 'Your watch has stopped. Plan another hunt whenever you’re ready.';
  }
  if (disconnected) {
    heading = 'Reconnect to see your next step.';
    description = 'Your saved cloud watch may keep running. The latest setup and availability need a connection.';
  } else if (busy) {
    heading = 'Getting your hunt ready…';
    description = 'Applying your choices. This only takes a moment.';
  }
  return {
    step, heading, description, active, hasStores,
    checkLabel: sameTarget && hasStores ? 'Check stock again' : 'Find stores & check stock',
    startLabel: state?.monitor?.enabled ? dirty ? 'Update & restart watch' : 'Restart watch' : 'Start cloud watch',
    storeSummary: hasStores ? `${selectedCount} ${draft?.watchAllNearby !== false ? 'nearby' : 'selected'} store${selectedCount === 1 ? '' : 's'}` : 'All nearby stores after the first check',
  };
}
