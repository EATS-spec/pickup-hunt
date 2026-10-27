/**
 * Five-minute cloud timer. Install in a standalone Apps Script project.
 * Keep the callback token in Script Properties, never in this source.
 * Apple inventory requests still pass through Pickup Hunt's shared request gate.
 */
var PICKUP_HUNT_ORIGIN_PROPERTY = 'PICKUP_HUNT_SITE_ORIGIN';
var PICKUP_HUNT_TOKEN_PROPERTY = 'PICKUP_HUNT_CALLBACK_TOKEN';
var PICKUP_HUNT_STATUS_PROPERTY = 'PICKUP_HUNT_RELAY_STATUS';

function setupPickupHunt() {
  return withPickupHuntLock_(function() {
    // Verify the deployed callback before replacing a previously working timer.
    var status = requestPickupHuntRefresh_('setup');
    var previous = pickupHuntTriggers_();
    var trigger = ScriptApp.newTrigger('refreshPickupHunt').timeBased().everyMinutes(5).create();
    // Creation can fail (for example, at Google's trigger quota). Preserve the
    // previous timer until a replacement actually exists.
    previous.forEach(function(item) { ScriptApp.deleteTrigger(item); });
    console.log('Pickup Hunt five-minute timer installed. Trigger: ' + trigger.getUniqueId());
    return status;
  });
}

function refreshPickupHunt(event) {
  return withPickupHuntLock_(function() {
    return requestPickupHuntRefresh_(event && event.triggerUid ? 'timer' : 'manual');
  });
}

function pickupHuntTimerStatus() {
  var properties = PropertiesService.getScriptProperties();
  var saved = properties.getProperty(PICKUP_HUNT_STATUS_PROPERTY);
  var status;
  try { status = saved ? JSON.parse(saved) : null; } catch (_) { status = null; }
  var result = {
    timerCount: pickupHuntTriggers_().length,
    cadenceMinutes: 5,
    targetConfigured: Boolean(properties.getProperty(PICKUP_HUNT_ORIGIN_PROPERTY)),
    callbackConfigured: Boolean(properties.getProperty(PICKUP_HUNT_TOKEN_PROPERTY)),
    relay: status,
    lastScheduledSuccessAt: properties.getProperty('PICKUP_HUNT_LAST_SCHEDULED_SUCCESS_AT')
  };
  // Only timing and outcome metadata. Never log credentials or response bodies.
  console.log(JSON.stringify(result));
  return result;
}

function stopPickupHuntTimer() {
  return withPickupHuntLock_(function() {
    pickupHuntTriggers_().forEach(function(item) { ScriptApp.deleteTrigger(item); });
    console.log('Pickup Hunt timer stopped. Existing watches are unchanged.');
    return { timerCount: 0 };
  });
}

function pickupHuntTriggers_() {
  return ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === 'refreshPickupHunt';
  });
}

function withPickupHuntLock_(operation) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { outcome: 'overlap-skipped' };
  try { return operation(); } finally { lock.releaseLock(); }
}

function requestPickupHuntRefresh_(source) {
  var properties = PropertiesService.getScriptProperties();
  var refreshURL = pickupHuntRefreshURL_(properties);
  var token = properties.getProperty(PICKUP_HUNT_TOKEN_PROPERTY);
  if (!token || token.length < 32 || /\s/.test(token)) {
    throw new Error('Set a valid PICKUP_HUNT_CALLBACK_TOKEN in Script Properties.');
  }
  var attemptedAt = new Date().toISOString();
  try {
    var response = UrlFetchApp.fetch(refreshURL, {
      method: 'post', contentType: 'application/json', payload: '{}',
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
      followRedirects: false
    });
    var code = response.getResponseCode();
    if (code !== 200) throw new Error('Pickup Hunt updater returned HTTP ' + code + '.');
    var result;
    try { result = JSON.parse(response.getContentText()); }
    catch (_) { throw new Error('Pickup Hunt updater returned an invalid response.'); }
    var heartbeat = result && result.health && result.health.lastTickAt;
    var heartbeatTime = Date.parse(heartbeat);
    if (!result.health || result.health.mode !== 'cloud' || !result.tick ||
        !Number.isFinite(heartbeatTime) || Date.now() - heartbeatTime > 120000 ||
        heartbeatTime - Date.now() > 60000) {
      throw new Error('Pickup Hunt did not confirm a fresh saved heartbeat.');
    }
    var status = {
      attemptedAt: attemptedAt, completedAt: new Date().toISOString(), source: source,
      ok: true, serverTickAt: heartbeat,
      outcome: String(result.tick.outcome || 'unknown'), checked: result.tick.checked === true
    };
    properties.setProperty(PICKUP_HUNT_STATUS_PROPERTY, JSON.stringify(status));
    if (source === 'timer') properties.setProperty('PICKUP_HUNT_LAST_SCHEDULED_SUCCESS_AT', status.completedAt);
    return status;
  } catch (error) {
    // UrlFetch error messages can include request details. Store no raw error,
    // token, response body, visitor preferences, or subscription information.
    properties.setProperty(PICKUP_HUNT_STATUS_PROPERTY, JSON.stringify({
      attemptedAt: attemptedAt, completedAt: new Date().toISOString(), source: source,
      ok: false, httpStatus: typeof code === 'number' ? code : null
    }));
    throw new Error('Pickup Hunt relay failed' + (typeof code === 'number' ? ' (HTTP ' + code + ')' : '') + '. Check the callback configuration and Site health.');
  }
}

function pickupHuntRefreshURL_(properties) {
  var origin = String(properties.getProperty(PICKUP_HUNT_ORIGIN_PROPERTY) || '').trim();
  // A deployment origin only: no credentials, paths, query parameters, or fragments.
  // Do not rely on the browser URL class, which is unavailable in Apps Script V8.
  var match = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::([0-9]{1,5}))?\/?$/i.exec(origin);
  if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
    throw new Error('Set PICKUP_HUNT_SITE_ORIGIN to your own HTTPS deployment origin, without a path.');
  }
  return origin.replace(/\/$/, '') + '/api/refresh';
}
