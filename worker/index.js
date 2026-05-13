// Cloudflare Worker — standalone deployment alternative
// Deploy with: wrangler deploy (from this directory)
// Then set: wrangler secret put ASHBY_API_KEY
//
// If using Pages Functions (recommended), use functions/api/report.js instead.

const ASHBY_BASE_URL = 'https://api.ashbyhq.com';

const BENCHMARKS = {
  overallConversion: { good: 0.05, warn: 0.02, bad: 0.01 },
  shortlistPassRate: { good: 0.20, warn: 0.10, bad: 0.05 },
  interview1PassRate: { good: 0.40, warn: 0.25, bad: 0.15 },
  techAssessmentPassRate: { good: 0.40, warn: 0.25, bad: 0.20 },
  timeToHireDays: { good: 21, warn: 30, bad: 45 },
  referralShareOfHires: { good: 0.30, warn: 0.15, bad: 0.05 },
  gobPassRateToInterview1: { good: 0.45, warn: 0.30, bad: 0.20 },
  hiringTarget: 18,
  targetDeadline: '2026-06-29',
};

const FUNNEL_STAGES = [
  { key: 'applicationReview',       label: 'Application Review',         match: 'application review' },
  { key: 'shortlist',               label: 'Shortlist',                  match: 'shortlist' },
  { key: 'interview1',              label: 'Interview 1',                match: 'interview 1' },
  { key: 'techAssessment',          label: 'Tech Assessment',            match: 'tech assessment' },
  { key: 'cultureBehavior',         label: 'Culture + Behavior',         match: 'culture' },
  { key: 'techInterviewSantiago',   label: 'Tech Interview Santiago',    match: 'tech interview' },
  { key: 'additionalCertification', label: 'Additional Certification',   match: 'additional' },
  { key: 'hired',                   label: 'Hired',                      match: 'hired' },
];

function getStageIndex(stageName) {
  if (!stageName) return 0;
  const lower = stageName.toLowerCase();
  for (let i = 0; i < FUNNEL_STAGES.length; i++) {
    if (lower.includes(FUNNEL_STAGES[i].match)) return i;
  }
  return 0;
}

async function ashbyPost(apiKey, endpoint, body = {}, retries = 4) {
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
          'Authorization': `Basic ${credentials}`,
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
      throw new Error('Ashby API rate limit exceeded');
    }

    let data;
    try { data = await res.json(); } catch { data = {}; }

    if (!res.ok) {
      const msg = data.error || data.message || `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500) throw new Error(`Ashby API: ${msg}`);
      if (attempt === retries - 1) throw new Error(`Ashby API: ${msg}`);
      continue;
    }

    return data;
  }
}

async function getAllApplications(apiKey, jobId) {
  const all = [];
  let cursor;
  let page = 0;
  const maxPages = 200;

  while (page < maxPages) {
    const body = { jobId };
    if (cursor) body.cursor = cursor;

    const data = await ashbyPost(apiKey, '/application.list', body);
    const results = Array.isArray(data.results) ? data.results : [];
    all.push(...results);

    cursor = data.nextCursor || null;
    if (!cursor) break;
    page++;
  }

  return all;
}

function getSourceLabel(app) {
  if (!app.source) return 'Unknown';
  if (typeof app.source === 'string') return app.source;
  return app.source.label || app.source.name || app.source.type || 'Unknown';
}

function getCurrentStageName(app) {
  if (app.status === 'Hired') return 'Hired';
  const s = app.currentInterviewStage || app.applicationStage || app.currentStage;
  if (s) return s.title || s.name || 'Application Review';
  return 'Application Review';
}

function getDateField(app, ...fields) {
  for (const f of fields) { if (app[f]) return app[f]; }
  return null;
}

function computeMetrics(applications) {
  const now = new Date();

  const augmented = applications.map(app => {
    const stageName = getCurrentStageName(app);
    const stageIdx = app.status === 'Hired'
      ? FUNNEL_STAGES.length - 1
      : getStageIndex(stageName);
    return { ...app, _stageName: stageName, _stageIdx: stageIdx };
  });

  const total       = augmented.length;
  const hired       = augmented.filter(a => a.status === 'Hired').length;
  const archived    = augmented.filter(a => a.status === 'Archived').length;
  const active      = augmented.filter(a => a.status === 'Active').length;
  const pendingOffer = augmented.filter(a => a.status === 'Active' && a._stageIdx >= 6).length;

  const funnel = FUNNEL_STAGES.map((stage, i) => {
    const reached      = augmented.filter(a => a._stageIdx >= i);
    const atStage      = augmented.filter(a => a._stageIdx === i);
    const totalReached = reached.length;
    const prevReached  = i === 0 ? total : augmented.filter(a => a._stageIdx >= i - 1).length;
    const passRate     = prevReached > 0 ? totalReached / prevReached : 1;
    return {
      stage: stage.label, key: stage.key, totalReached,
      activeAtStage:   atStage.filter(a => a.status === 'Active').length,
      archivedAtStage: atStage.filter(a => a.status === 'Archived').length,
      passRate,
    };
  });

  const sourceMap = new Map();
  augmented.forEach(app => {
    const source = getSourceLabel(app);
    if (!sourceMap.has(source)) sourceMap.set(source, { total: 0, hires: 0, active: 0, reachedInterview1: 0 });
    const s = sourceMap.get(source);
    s.total++;
    if (app.status === 'Hired')  s.hires++;
    if (app.status === 'Active') s.active++;
    if (app._stageIdx >= 2)      s.reachedInterview1++;
  });

  const sources = [...sourceMap.entries()]
    .map(([name, d]) => ({
      name, total: d.total, hires: d.hires, active: d.active,
      interview1PassRate: d.total > 0 ? d.reachedInterview1 / d.total : 0,
    }))
    .sort((a, b) => b.total - a.total);

  const velocity = [];
  for (let i = 3; i >= 0; i--) {
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - i * 7);
    weekEnd.setHours(23, 59, 59, 999);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 6);
    weekStart.setHours(0, 0, 0, 0);
    const label = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    velocity.push({
      week: label,
      interviews: augmented.filter(a => {
        if (a._stageIdx < 2) return false;
        const d = new Date(getDateField(a, 'applicationDate', 'createdAt', 'appliedAt') || 0);
        return d >= weekStart && d <= weekEnd;
      }).length,
      hires: augmented.filter(a => {
        if (a.status !== 'Hired') return false;
        const d = new Date(getDateField(a, 'hiredAt', 'hiredDate', 'updatedAt') || 0);
        return d >= weekStart && d <= weekEnd;
      }).length,
    });
  }

  const gobEntry = [...sourceMap.entries()].find(([k]) =>
    k.toLowerCase().includes('get on board') || k.toLowerCase().includes('getonboard'));
  const gobStats = gobEntry ? {
    source: gobEntry[0], total: gobEntry[1].total, hires: gobEntry[1].hires,
    active: gobEntry[1].active,
    interview1PassRate: gobEntry[1].total > 0 ? gobEntry[1].reachedInterview1 / gobEntry[1].total : 0,
  } : null;

  const refEntry = [...sourceMap.entries()].find(([k]) => k.toLowerCase().includes('referral'));
  const referralHires = refEntry ? refEntry[1].hires : 0;

  return {
    generatedAt: now.toISOString(),
    pipeline: { totalApplications: total, totalActive: active, totalArchived: archived, totalHired: hired, pendingOffer },
    funnel, sources, velocity,
    overallConversion: total > 0 ? hired / total : 0,
    topSource: sources.length > 0 ? sources[0].name : 'N/A',
    gobStats, referralHires,
    referralShareOfHires: hired > 0 ? referralHires / hired : 0,
    benchmarks: BENCHMARKS,
  };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname !== '/api/report') {
      return new Response('Not Found', { status: 404 });
    }

    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const cache = caches.default;
    const cacheKey = new Request('https://futureproofing-internal-cache/worker-report-v2');

    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      Object.entries(corsHeaders()).forEach(([k, v]) => resp.headers.set(k, v));
      resp.headers.set('X-Cache', 'HIT');
      return resp;
    }

    try {
      const apiKey = env.ASHBY_API_KEY;
      if (!apiKey) throw new Error('ASHBY_API_KEY environment variable is not set');

      const jobsData = await ashbyPost(apiKey, '/job.list', {});
      let jobs = jobsData.results || [];

      let aiJobs = jobs.filter(j => j.title?.toLowerCase().includes('ai engineer'));
      if (aiJobs.length === 0) {
        aiJobs = jobs.filter(j =>
          j.title?.toLowerCase().includes(' ai ') ||
          j.title?.toLowerCase().includes('machine learning') ||
          j.title?.toLowerCase().includes('ml engineer')
        );
      }

      if (aiJobs.length === 0) {
        return jsonResponse({
          error: 'No AI Engineer job found in Ashby.',
          availableJobs: jobs.slice(0, 30).map(j => ({ id: j.id, title: j.title })),
        }, 404);
      }

      let allApplications = [];
      for (const job of aiJobs) {
        const apps = await getAllApplications(apiKey, job.id);
        allApplications.push(...apps);
      }

      const seen = new Set();
      allApplications = allApplications.filter(a => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
      });

      const metrics = computeMetrics(allApplications);

      const response = new Response(JSON.stringify(metrics, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(),
          'Cache-Control': 'public, max-age=300',
          'X-Cache': 'MISS',
        },
      });

      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      console.error('[worker] Error:', err.message);
      return jsonResponse({ error: err.message, timestamp: new Date().toISOString() }, 500);
    }
  },
};
