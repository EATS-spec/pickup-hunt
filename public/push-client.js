const toBytes = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));

/** Prepare registration/key before the click so Safari receives subscribe in a user gesture. */
export function createPushController({ onChange = () => {}, environment = globalThis, fetcher = (...args) => fetch(...args) } = {}) {
  const nav = environment.navigator, NotificationAPI = environment.Notification;
  const ios = /iPad|iPhone|iPod/.test(nav?.userAgent || '') || (nav?.platform === 'MacIntel' && nav?.maxTouchPoints > 1);
  const standalone = Boolean(environment.matchMedia?.('(display-mode: standalone)').matches || nav?.standalone);
  const supported = Boolean(environment.isSecureContext && nav?.serviceWorker && environment.PushManager && NotificationAPI);
  let registration = null, browserSubscription = null, initialized = null;
  let state = { supported, configured: false, installRequired: ios && !standalone, permission: NotificationAPI?.permission || 'default',
    subscribed: false, needsResubscribe: false, busy: false, ready: false, canEnable: false, canTest: false, watchEnabled: false,
    message: '', error: null, lastSentAt: null, lastDisplayedAt: null, lastTestAt: null, lastError: null, test: null };
  const emit = patch => {
    state = { ...state, ...patch, permission: NotificationAPI?.permission || 'default' };
    state.canEnable = Boolean(state.ready && state.supported && !state.installRequired && state.configured && !state.subscribed && !state.busy && state.permission !== 'denied');
    state.canTest = Boolean(state.ready && state.subscribed && !state.busy);
    onChange({ ...state }); return { ...state };
  };
  const request = async (path, input) => {
    const response = await fetcher(path, { credentials: 'same-origin', cache: 'no-store', ...(input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not update notifications.');
    return result;
  };
  const explain = () => {
    if (state.installRequired) return 'On iPhone or iPad: open in Safari, choose Share → Add to Home Screen, then open that app to enable alerts.';
    if (!state.supported) return 'This browser cannot receive background alerts. Open Pickup Hunt in Safari, Chrome, Firefox, or Edge.';
    if (state.permission === 'denied') return 'Notifications are blocked. Allow them in this browser’s site settings, then reload.';
    if (!state.configured) return 'Background notifications are temporarily unavailable. You can still check availability here.';
    if (state.needsResubscribe) return 'This device’s notification subscription expired or changed. Enable notifications again to reconnect it.';
    if (state.test?.displayedAt) return 'Test notification displayed on this device.';
    if (state.test?.state === 'sent') return 'Test accepted by the push service. Waiting for this device to confirm display.';
    if (state.test?.state === 'pending' || state.test?.state === 'sending') return 'Test queued for the next background tick. You can close this page now.';
    if (state.subscribed) return state.watchEnabled ? 'Background alerts are enabled for this device. You can close the page.' : 'Alerts are enabled on this device. Start your watch to receive stock alerts.';
    return 'Get a notification on this device when a watched store has your phone—even with this page closed.';
  };
  const refresh = async () => {
    try {
      const result = await request('/api/push');
      if (registration) browserSubscription = await registration.pushManager.getSubscription();
      emit({ ...result, subscribed: Boolean(result.subscribed && browserSubscription), error: null });
      return emit({ message: explain() });
    } catch (error) { return emit({ error: error.message }); }
  };
  const init = () => initialized ||= (async () => {
    emit({ busy: true });
    try {
      const result = await request('/api/push'); emit(result);
      if (supported && !state.installRequired && state.configured) {
        registration = await nav.serviceWorker.register('/sw.js', { scope: '/' });
        let timer;
        try { registration = await Promise.race([nav.serviceWorker.ready, new Promise((_, reject) => { timer = environment.setTimeout(() => reject(new Error('Notifications are still starting. Reload and try again.')), 10_000); })]); }
        finally { environment.clearTimeout?.(timer); }
        browserSubscription = await registration.pushManager.getSubscription();
        if (browserSubscription?.options?.applicationServerKey) {
          const currentKey = new Uint8Array(browserSubscription.options.applicationServerKey), wantedKey = toBytes(state.publicKey);
          if (currentKey.length !== wantedKey.length || currentKey.some((byte, index) => byte !== wantedKey[index])) emit({ needsResubscribe: true, subscribed: false });
        }
        if (browserSubscription && state.permission === 'granted' && !state.subscribed && !state.needsResubscribe) {
          const synced = await request('/api/push/subscribe', { subscription: browserSubscription.toJSON() });
          emit(synced);
        } else if (!browserSubscription) emit({ subscribed: false });
      } else emit({ subscribed: false });
    } catch (error) { emit({ error: error.message, subscribed: false }); }
    finally { emit({ busy: false, ready: true }); emit({ message: explain() }); }
    return { ...state };
  })();
  const enable = async () => {
    if (!state.canEnable || !registration) return emit({ message: explain() });
    // No await before this call: the browser's permission prompt is explicitly user initiated.
    let subscriptionPromise;
    try {
      const subscribe = () => registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(state.publicKey) });
      // Permission is already granted for a retained expired subscription. An explicit
      // reconnect replaces it; fresh permission prompts still begin synchronously.
      subscriptionPromise = state.needsResubscribe && browserSubscription ? browserSubscription.unsubscribe().then(subscribe) : subscribe();
    }
    catch (error) { return emit({ error: error.message }); }
    emit({ busy: true, error: null });
    try {
      browserSubscription = await subscriptionPromise;
      const result = await request('/api/push/subscribe', { subscription: browserSubscription.toJSON() });
      emit({ ...result, subscribed: true });
    } catch (error) {
      emit({ error: NotificationAPI.permission === 'denied' ? 'Notifications were blocked. You can change this in the browser’s site settings.' : error.message, subscribed: false });
    } finally { emit({ busy: false }); emit({ message: explain() }); }
    return { ...state };
  };
  const disable = async () => {
    emit({ busy: true, error: null });
    try {
      // Disable cloud delivery first. Browser unsubscribe failure cannot leave the watch sending.
      const result = await request('/api/push/unsubscribe', {});
      emit({ ...result, subscribed: false });
      if (registration) { const sub = await registration.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); }
      browserSubscription = null; emit({ ...result, subscribed: false });
    } catch (error) { emit({ error: error.message }); }
    finally { emit({ busy: false }); emit({ message: explain() }); }
    return { ...state };
  };
  const test = async () => {
    if (!state.canTest) return { ...state };
    emit({ busy: true, error: null });
    try { emit(await request('/api/push/test', {})); }
    catch (error) { emit({ error: error.message }); }
    finally { emit({ busy: false }); emit({ message: explain() }); }
    return { ...state };
  };
  nav?.serviceWorker?.addEventListener?.('message', event => { if (event.data?.type === 'pickup-push-displayed') void refresh(); });
  environment.document?.addEventListener?.('visibilitychange', () => { if (state.ready && environment.document.visibilityState === 'visible') void refresh(); });
  return { init, enable, disable, test, refresh, getState: () => ({ ...state }) };
}
