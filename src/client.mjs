export const ORIGIN = 'https://socialquery.dev';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class SocialQueryError extends Error {}

function checkPath(path) {
  if (typeof path !== 'string' || !/^\/v1\/[a-zA-Z0-9_/-]+$/.test(path) || path.includes('//')) {
    throw new SocialQueryError('Unsupported API path. Use an endpoint from the public catalog.');
  }
}

async function readJson(response) {
  if (!response.body) throw new SocialQueryError('Empty API response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SocialQueryError('API response exceeds 4 MiB. Narrow the query or page size.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SocialQueryError('API returned invalid JSON.'); }
}

export class SocialQueryClient {
  constructor({ apiKey = process.env.SOCIALQUERY_API_KEY, fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async get(path, parameters = {}, options = {}) {
    return this.request('GET', path, parameters, options);
  }

  async request(method, path, parameters = {}, { authenticated = true, idempotencyKey, maxCredits } = {}) {
    checkPath(path);
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new SocialQueryError('Unsupported HTTP method.');
    if (authenticated && !this.apiKey) throw new SocialQueryError('Supply a SocialQuery API key: Authorization: Bearer for HTTP, or SOCIALQUERY_API_KEY for local stdio.');
    const url = new URL(path, ORIGIN);
    const body = {};
    for (const [name, value] of Object.entries(parameters)) {
      let encoded;
      try { encoded = typeof value === 'string' ? value : JSON.stringify(value, (_key, item) => {
        if (typeof item === 'number' && !Number.isFinite(item) || typeof item === 'undefined' || typeof item === 'function' || typeof item === 'symbol') throw Error('Invalid JSON value');
        return item;
      }); } catch { throw new SocialQueryError('Parameters must contain finite JSON values.'); }
      if (typeof encoded !== 'string' || encoded.length > 16000) throw new SocialQueryError('Each encoded parameter must fit within 16000 characters.');
      if (method === 'GET') url.searchParams.set(name, encoded);
      else body[name] = value;
    }
    const headers = { Accept: 'application/json' };
    if (authenticated) headers['x-api-key'] = this.apiKey;
    if (maxCredits !== undefined) {
      if (!Number.isSafeInteger(maxCredits) || maxCredits < 0) throw new SocialQueryError('Invalid credit cap.');
      headers['X-Max-Credits'] = String(maxCredits);
    }
    if (idempotencyKey !== undefined) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new SocialQueryError('Idempotency key must be 8–128 letters, digits, underscores, or hyphens.');
      headers['Idempotency-Key'] = idempotencyKey;
    }
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.fetch(url, { method, headers, ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60000) });
    } catch { throw new SocialQueryError('SocialQuery request failed or timed out. No automatic retry was made.'); }
    if (!response.ok) {
      const requestId = (response.headers.get('x-request-id') ?? 'unavailable').replace(/[^a-zA-Z0-9_-]/g, '').slice(0,100);
      await response.body?.cancel();
      throw new SocialQueryError(`SocialQuery HTTP ${response.status}; request ID: ${requestId}. No automatic retry was made.`);
    }
    const result = await readJson(response);
    if (!result || result.success !== true) throw new SocialQueryError('SocialQuery returned an unsuccessful response.');
    if (maxCredits !== undefined && (!Number.isSafeInteger(result.credits_used) || result.credits_used < 0 || result.credits_used > maxCredits)) throw new SocialQueryError('Response credit usage exceeded the approved cap or was invalid.');
    return result;
  }

  async platforms() {
    return (await this.get('/v1/meta/platforms', {}, { authenticated: false })).data.platforms;
  }

  async endpoints() {
    const data = (await this.get('/v1/meta/endpoints', {}, { authenticated: false })).data;
    if (!Array.isArray(data?.endpoints)) throw new SocialQueryError('Invalid endpoint catalog.');
    return data.endpoints;
  }

  async endpoint(endpointId) {
    const endpoint = (await this.endpoints()).find(item => item.id === endpointId);
    if (!endpoint) throw new SocialQueryError('Unknown endpoint ID. Use list_endpoints to discover an operation.');
    return endpoint;
  }

  async callEndpoint({ endpointId, parameters = {}, maxCredits, idempotencyKey, allowMutation = false }) {
    const endpoint = await this.endpoint(endpointId);
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(endpoint.method)) throw new SocialQueryError('Unsupported endpoint method.');
    if (endpoint.method !== 'GET' && !allowMutation) throw new SocialQueryError('Use execute_endpoint for POST, PATCH, or DELETE only when the user requested that action; call_endpoint is GET only.');
    if (endpoint.method !== 'GET' && !idempotencyKey) throw new SocialQueryError('Mutating requests require an idempotencyKey to prevent duplicate work on deliberate retries.');
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new SocialQueryError('Parameters must be an object.');
    let quotedCost = endpoint.creditCost;
    let resolvedPricing = false;
    if (endpoint.creditPricing !== undefined) {
      const pricing = endpoint.creditPricing;
      if (pricing?.type === 'resolved_endpoint') {
        if (endpoint.path !== '/v1/prism/lookup' || !Number.isSafeInteger(pricing.maxCredits) || pricing.maxCredits < 1) throw new SocialQueryError('Invalid resolved pricing metadata.');
        resolvedPricing = true;
        quotedCost = pricing.maxCredits;
      } else if (pricing?.type === 'trend_boards') {
        if (endpoint.path !== '/v1/tiktok/hashtags/popular' || pricing.creditsPerItem !== 2 || pricing.minimumCredits !== 6 || pricing.maxItems !== 48) throw new SocialQueryError('Invalid trend-board pricing metadata.');
        quotedCost = parameters.industry === 'all' ? 96 : 6;
      } else if (pricing?.type === 'post_stats_batch') {
        if (endpoint.path !== '/v1/prism/post-stats' || pricing.maxItems !== 100 || pricing.defaultCredits !== 1 || JSON.stringify(pricing.platformCredits) !== JSON.stringify({instagram:2,linkedin:5})) throw new SocialQueryError('Invalid post-statistics pricing metadata.');
        let urls=parameters.urls;
        if(typeof urls==='string'){try{urls=JSON.parse(urls);}catch{throw new SocialQueryError('Invalid post URLs.');}}
        if(!Array.isArray(urls)||urls.length<1||urls.length>100||urls.some(url=>typeof url!=='string'||!url.trim()||url.length>2048))throw new SocialQueryError('Invalid post URLs.');
        quotedCost=urls.reduce((sum,url)=>{let host;try{host=new URL(url).hostname.toLowerCase().replace(/^www\./,'');}catch{}return sum+(host==='instagram.com'?2:host==='linkedin.com'?5:1);},0);
      } else if (pricing?.type === 'profile_batch') {
        if (endpoint.path !== '/v1/prism/profiles' || pricing.maxItems !== 50 || pricing.defaultCredits !== 1 || JSON.stringify(pricing.platformCredits) !== JSON.stringify({linkedin:5})) throw new SocialQueryError('Invalid profile pricing metadata.');
        let items = parameters.items;
        if (typeof items === 'string') { try { items = JSON.parse(items); } catch { throw new SocialQueryError('Invalid profile items.'); } }
        if (!Array.isArray(items) || items.length < 1 || items.length > 50 || items.some(item => !item || typeof item !== 'object' || typeof item.platform !== 'string' || typeof item.handle !== 'string' || !item.handle.trim())) throw new SocialQueryError('Invalid profile items.');
        quotedCost = items.reduce((sum,item) => sum + (item.platform === 'linkedin' ? 5 : 1),0);
      } else if (pricing?.type === 'per_successful_input') {
        if (endpoint.path !== '/v1/youtube/transcripts' || pricing.arrayParameter !== 'ids' || pricing.creditsPerItem !== 3 || pricing.maxItems !== 100) throw new SocialQueryError('Invalid batch pricing metadata.');
        let ids = parameters.ids;
        if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { throw new SocialQueryError('Invalid transcript IDs.'); } }
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > pricing.maxItems || !ids.every(id => typeof id === 'string' && /^[\w-]{11}$/.test(id))) throw new SocialQueryError('Invalid transcript IDs.');
        quotedCost = ids.length * pricing.creditsPerItem;
      } else {
      if (pricing?.type !== 'per_item' || !Number.isSafeInteger(pricing.creditsPerItem) || pricing.creditsPerItem < 1 || !Number.isSafeInteger(pricing.maxLimit) || pricing.maxLimit < 1 || !Number.isSafeInteger(pricing.defaultLimit) || pricing.defaultLimit < 1 || pricing.defaultLimit > pricing.maxLimit || typeof pricing.limitParameter !== 'string') throw new SocialQueryError('Invalid metered pricing metadata.');
      const raw = Object.hasOwn(parameters, pricing.limitParameter) ? parameters[pricing.limitParameter] : pricing.defaultLimit;
      const limit = Number(raw);
      if (!['string','number'].includes(typeof raw) || typeof raw === 'string' && !/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit < 1 || limit > pricing.maxLimit) throw new SocialQueryError('Invalid metered request limit.');
      quotedCost = limit * pricing.creditsPerItem;
      }
    }
    if (!Number.isSafeInteger(maxCredits) || maxCredits < 0 || !Number.isSafeInteger(quotedCost) || quotedCost < 0 || !resolvedPricing && quotedCost > maxCredits) {
      throw new SocialQueryError('The maximum request charge exceeds maxCredits, or the budget/cost is invalid.');
    }
    const specs = endpoint.params ?? [];
    const allowed = new Set(specs.map(param => param.name));
    if (Object.keys(parameters).some(name => !allowed.has(name))) throw new SocialQueryError('Unknown parameter. Inspect get_endpoint for allowed inputs.');
    const hasValue = name => Object.hasOwn(parameters, name) && parameters[name] !== '' && parameters[name] !== null && parameters[name] !== undefined;
    const missing = specs.filter(param => param.required && !hasValue(param.name));
    if (missing.length) throw new SocialQueryError(`Missing required parameters: ${missing.map(param => param.name).join(', ')}.`);
    if ((endpoint.oneOfParameters ?? []).some(group => !group.some(hasValue))) throw new SocialQueryError('Supply at least one parameter from each alternative group in get_endpoint.');
    const query = { ...parameters };
    const path = endpoint.path.replace(/\{([^}]+)\}/g, (_, name) => {
      const value = query[name];
      if (!hasValue(name) || !/^[a-zA-Z0-9_-]+$/.test(String(value))) throw new SocialQueryError('Path parameters must contain only letters, digits, underscores, or hyphens.');
      delete query[name];
      return String(value);
    });
    // One data request, with no hidden retries or pagination. Catalog reads are free.
    return this.request(endpoint.method, path, query, { idempotencyKey, maxCredits });
  }

  balance() { return this.get('/v1/credits/balance'); }
}
