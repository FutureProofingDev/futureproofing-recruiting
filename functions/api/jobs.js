// GET /api/jobs — diagnostic: lists all jobs across all pages
const ASHBY_BASE_URL = 'https://api.ashbyhq.com';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function ashbyPost(apiKey, endpoint, body = {}) {
  const credentials = btoa(`${apiKey}:`);
  const res = await fetch(`${ASHBY_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  try { return await res.json(); } catch { return {}; }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

export async function onRequestGet({ env }) {
  const apiKey = env.ASHBY_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'No API key' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }

  const allJobs = [];
  let cursor;
  let page = 0;

  while (page < 20) {
    const body = { includeArchived: true };
    if (cursor) body.cursor = cursor;
    const data = await ashbyPost(apiKey, '/job.list', body);
    allJobs.push(...(data.results || []));
    cursor = data.nextCursor || null;
    if (!cursor) break;
    page++;
  }

  const result = {
    totalJobs: allJobs.length,
    jobs: allJobs.map(j => ({ id: j.id, title: j.title, status: j.status })),
  };

  return new Response(JSON.stringify(result, null, 2), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
