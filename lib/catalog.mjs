import seed from './catalog-seed.json' with { type: 'json' };
import { CATALOG_URL, CATALOG_TTL_MS, discoverFamilyPages, parseFamilyPage, validateCachedCatalog } from './catalog-parser.mjs';
export class CloudCatalog {
  constructor({db, fetchImpl = fetch, now = () => Date.now()}) { this.db = db; this.fetchImpl = fetchImpl; this.now = now; this.snapshot = null; }
  async load({refresh = false} = {}) {
    const saved = await this.db.prepare('SELECT payload_json FROM hunt_catalog WHERE id = ?').bind('apple-us').first();
    let value;
    try { value = validateCachedCatalog(saved ? JSON.parse(saved.payload_json) : seed); } catch { value = validateCachedCatalog(seed); }
    let error;
    if (refresh) {
      try {
        const read = async url => {
          const response = await this.fetchImpl(url, {headers:{Accept:'text/html'},signal:AbortSignal.timeout(25_000)});
          if (!response.ok) throw new Error(`Apple catalog returned HTTP ${response.status}.`);
          if (response.url && new URL(response.url).origin !== 'https://www.apple.com') throw new Error('Apple redirected to another storefront.');
          const html = await response.text();
          if (html.length > 8_000_000) throw new Error('Apple catalog page exceeded its size limit.');
          return html;
        };
        const urls = discoverFamilyPages(await read(CATALOG_URL));
        const models = [], pages = [];
        for (const url of urls) {
          const found = parseFamilyPage(await read(url),url);
          if (found.some(item => models.some(model => model.id === item.id))) throw new Error('Apple returned ambiguous model coverage.');
          models.push(...found); pages.push({url, modelIds:found.map(item=>item.id)});
        }
        for (const oldPage of value.pages.filter(page=>urls.includes(page.url))) for (const id of oldPage.modelIds) {
          const previous = value.models.find(model=>model.id===id), next = models.find(model=>model.id===id);
          if (!next || next.variants.length < previous.variants.length) throw new Error('Apple returned an incomplete catalog.');
        }
        value = validateCachedCatalog({version:1,updatedAt:new Date(this.now()).toISOString(),source:CATALOG_URL,models,pages});
      } catch (cause) { error = `${cause.message} Retaining the last complete catalog.`; }
    }
    if ((!saved || refresh) && !error) await this.db.prepare('INSERT INTO hunt_catalog (id,payload_json,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at').bind('apple-us',JSON.stringify(value),this.now()).run();
    const stale = this.now() - Date.parse(value.updatedAt) >= CATALOG_TTL_MS || !!error;
    this.snapshot = {updatedAt:value.updatedAt,source:value.source,models:value.models,stale,...(error?{error}:{})};
    return structuredClone(this.snapshot);
  }
  resolveSelection(selection = {}) {
    const norm = value => String(value ?? '').toLowerCase().replace(/\s+/g,'');
    const variant = this.snapshot?.models.flatMap(model=>model.variants).find(item=>['modelId','color','storage'].every(key=>norm(item[key])===norm(selection[key])));
    if (!variant) throw new Error('Choose a model, color, and storage in the current Apple catalog.');
    return structuredClone(variant);
  }
}
