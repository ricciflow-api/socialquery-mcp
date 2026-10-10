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

  async get(path, parameters = {}, { authenticated = true, idempotencyKey } = {}) {
    checkPath(path);
    if (authenticated && !this.apiKey) throw new SocialQueryError('Set SOCIALQUERY_API_KEY in the MCP server environment.');
    const url = new URL(path, ORIGIN);
    for (const [name, value] of Object.entries(parameters)) {
      if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 16000 || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new SocialQueryError('Parameters must be finite numbers, booleans, or strings up to 16000 characters.');
      }
      url.searchParams.set(name, String(value));
    }
    const headers = { Accept: 'application/json' };
    if (authenticated) headers['x-api-key'] = this.apiKey;
    if (idempotencyKey !== undefined) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new SocialQueryError('Idempotency key must be 8–128 letters, digits, underscores, or hyphens.');
      headers['Idempotency-Key'] = idempotencyKey;
    }
    let response;
    try {
      response = await this.fetch(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(60000) });
    } catch { throw new SocialQueryError('SocialQuery request failed or timed out. No automatic retry was made.'); }
    if (!response.ok) {
      const requestId = (response.headers.get('x-request-id') ?? 'unavailable').replace(/[^a-zA-Z0-9_-]/g, '').slice(0,100);
      await response.body?.cancel();
      throw new SocialQueryError(`SocialQuery HTTP ${response.status}; request ID: ${requestId}. No automatic retry was made.`);
    }
    const result = await readJson(response);
    if (!result || result.success !== true) throw new SocialQueryError('SocialQuery returned an unsuccessful response.');
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

  async callEndpoint({ endpointId, parameters = {}, maxCredits, idempotencyKey }) {
    const endpoint = await this.endpoint(endpointId);
    if (endpoint.method !== 'GET') throw new SocialQueryError('This MCP supports GET data operations only. Use REST for POST, PATCH, and DELETE operations.');
    if (!Number.isInteger(maxCredits) || maxCredits < 0 || !Number.isFinite(endpoint.creditCost) || endpoint.creditCost < 0 || endpoint.creditCost > maxCredits) {
      throw new SocialQueryError('The catalog credit cost exceeds maxCredits, or the budget/cost is invalid.');
    }
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new SocialQueryError('Parameters must be an object.');
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
    return this.get(path, query, { idempotencyKey });
  }

  balance() { return this.get('/v1/credits/balance'); }
}
