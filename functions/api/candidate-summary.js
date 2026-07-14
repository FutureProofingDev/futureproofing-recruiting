// Cloudflare Pages Function — proxy to the AI Candidate Evaluation Engine
// (separate Worker in /engine). Keeps ENGINE_INTERNAL_KEY off the browser,
// exactly like ASHBY_API_KEY/NOTION_API_KEY are kept server-side in
// report.js / talent.js.
//
// Secrets / vars needed on this Pages project:
//   EVAL_ENGINE_URL      (var)    — the deployed engine Worker's URL
//   ENGINE_INTERNAL_KEY  (secret) — must match the same secret set on the engine Worker
//
// Usage:
//   GET  /api/candidate-summary                → list candidates (all pipelines)
//   GET  /api/candidate-summary?pipeline=X      → list candidates for one pipeline
//   GET  /api/candidate-summary?id=123          → full detail for one candidate
//   GET  /api/candidate-summary?id=123&action=resume → 302 redirect to a freshly-signed resume URL
//   POST /api/candidate-summary?id=123&action=regenerate → manual re-run
//   POST /api/candidate-summary?id=123&action=manual-note&noteType=employment_history
//        (JSON body = the note content) → add/replace a manually-entered note

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function callEngine(env, path, options = {}) {
  const base = env.EVAL_ENGINE_URL;
  if (!base) throw new Error('EVAL_ENGINE_URL is not set');
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'X-Engine-Key': env.ENGINE_INTERNAL_KEY || '',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) throw new Error(data.error || `Engine error HTTP ${res.status}`);
  return data;
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const pipeline = url.searchParams.get('pipeline');
  const action = url.searchParams.get('action');

  try {
    if (id && action === 'resume') {
      const data = await callEngine(env, `/api/candidates/${encodeURIComponent(id)}/resume-url`);
      return Response.redirect(data.url, 302);
    }
    if (id) {
      const data = await callEngine(env, `/api/candidates/${encodeURIComponent(id)}`);
      return jsonResponse(data);
    }
    const qs = pipeline ? `?pipeline=${encodeURIComponent(pipeline)}` : '';
    const data = await callEngine(env, `/api/candidates${qs}`);
    return jsonResponse(data);
  } catch (err) {
    return jsonResponse({ error: err.message }, action === 'resume' ? 404 : 500);
  }
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const action = url.searchParams.get('action');

  if (!id) {
    return jsonResponse({ error: 'Expected ?id=<candidateId>&action=regenerate|manual-note' }, 400);
  }

  try {
    if (action === 'regenerate') {
      const data = await callEngine(env, `/api/candidates/${encodeURIComponent(id)}/regenerate`, { method: 'POST' });
      return jsonResponse(data);
    }

    if (action === 'manual-note') {
      const noteType = url.searchParams.get('noteType');
      if (!noteType) return jsonResponse({ error: 'Expected ?noteType=' }, 400);
      const body = await request.json();
      const data = await callEngine(env, `/api/candidates/${encodeURIComponent(id)}/manual-notes/${encodeURIComponent(noteType)}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return jsonResponse(data);
    }

    return jsonResponse({ error: 'Unknown action' }, 400);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}
