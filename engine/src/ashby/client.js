// Generic Ashby API client — Basic auth, retry/backoff, cursor pagination.
// Extracted from the duplicated logic already in
// ../../functions/api/report.js and ../../functions/api/talent.js so the
// evaluation engine and the dashboard can eventually share one client.

const ASHBY_BASE_URL = 'https://api.ashbyhq.com';

export async function ashbyPost(apiKey, endpoint, body = {}, retries = 4) {
  const credentials = btoa(`${apiKey}:`);

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, Math.min(Math.pow(2, attempt - 1) * 1200, 10000)));
    }

    let res;
    try {
      res = await fetch(`${ASHBY_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      if (attempt === retries - 1) throw networkErr;
      continue;
    }

    if (res.status === 429) {
      if (attempt < retries - 1) continue;
      throw new Error(`Ashby API rate limit exceeded after retries (${endpoint})`);
    }

    let data;
    try { data = await res.json(); } catch { data = {}; }

    if (!res.ok) {
      const msg = data.error || data.message || `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500) throw new Error(`Ashby API ${endpoint}: ${msg}`);
      if (attempt === retries - 1) throw new Error(`Ashby API ${endpoint}: ${msg}`);
      continue;
    }

    return data;
  }
}

// Best-effort variant: returns `fallback` instead of throwing. Used for
// endpoints/scopes that may not exist for every Ashby org (e.g. add-ons).
export async function ashbyPostSafe(apiKey, endpoint, body = {}, fallback = null) {
  try {
    return await ashbyPost(apiKey, endpoint, body, 2);
  } catch {
    return fallback;
  }
}

export async function ashbyPaginate(apiKey, endpoint, filter = {}, { maxPages = 300 } = {}) {
  const all = [];
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const body = { ...filter, limit: 100 };
    if (cursor) body.cursor = cursor;
    const data = await ashbyPost(apiKey, endpoint, body);
    const results = Array.isArray(data.results) ? data.results : [];
    all.push(...results);
    cursor = data.nextCursor || null;
    if (!cursor) break;
  }
  return all;
}

// Run an async fn over items with bounded concurrency (keeps Ashby rate
// limits happy when fetching per-candidate data for many candidates).
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
