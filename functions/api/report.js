// Cloudflare Pages Function — GET /api/report
// Fetches live data from Ashby ATS and computes recruiting funnel metrics

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

// Ordered funnel stages — matched via partial string on stage title
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
      throw new Error('Ashby API rate limit exceeded after retries');
    }

    let data;
    try { data = await res.json(); } catch { data = {}; }

    if (!res.ok) {
      const msg = data.error || data.message || `HTTP ${res.status}`;
      // Don't retry 4xx (except 429 handled above)
      if (res.status >= 400 && res.status < 500) throw new Error(`Ashby API: ${msg}`);
      if (attempt === retries - 1) throw new Error(`Ashby API: ${msg}`);
      continue;
    }

    return data;
  }
}

async function getAllApplications(apiKey, filter = {}) {
  const all = [];
  let cursor;
  let page = 0;
  const maxPages = 300;

  while (page < maxPages) {
    const body = { ...filter, limit: 100 };
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

// Normalize source names so duplicate/variant labels are merged
function normalizeSourceName(raw) {
  if (!raw) return null;
  const r = raw.trim();
  const lower = r.toLowerCase();
  // "Applied" = people who clicked Apply directly on the posting (LinkedIn + organic traffic)
  if (lower === 'applied') return 'LinkedIn + Organic';
  // Merge capitalization variants
  if (lower === 'juicebox') return 'JuiceBox';
  if (lower === 'linkedin') return 'LinkedIn Limited Listings';
  return r;
}

function getSourceLabel(app) {
  // Try every known Ashby field variation for source
  const s = app.source || app.applicationSource || app.sourceType || app.origin;
  if (!s) {
    // Fall back to credited recruiter or channel tag
    if (app.creditedToUser?.name) return `Recruiter: ${app.creditedToUser.name}`;
    return null; // explicitly null = no source data
  }
  const raw = typeof s === 'string' ? s : (s.title || s.label || s.name || s.displayName || s.type || s.subtype || null);
  return normalizeSourceName(raw);
}

function getCurrentStageName(app) {
  if ((app.status || '').toLowerCase() === 'hired') return 'Hired';
  const s = app.currentInterviewStage || app.applicationStage || app.currentStage;
  if (s) return s.title || s.name || 'Application Review';
  return 'Application Review';
}

function getDateField(app, ...fields) {
  for (const f of fields) {
    if (app[f]) return app[f];
  }
  return null;
}

function computeMetrics(applications) {
  const now = new Date();

  // Case-insensitive status helper
  const st = a => (a.status || '').toLowerCase();

  // Augment each application with resolved stage index
  const augmented = applications.map(app => {
    const stageName = getCurrentStageName(app);
    const stageIdx = st(app) === 'hired'
      ? FUNNEL_STAGES.length - 1
      : getStageIndex(stageName);
    return { ...app, _stageName: stageName, _stageIdx: stageIdx };
  });

  // Pipeline totals
  const total     = augmented.length;
  const hired     = augmented.filter(a => st(a) === 'hired').length;
  const archived  = augmented.filter(a => st(a) === 'archived').length;
  const active    = augmented.filter(a => st(a) === 'active').length;
  const leads     = augmented.filter(a => st(a) === 'lead').length;
  const pendingOffer = augmented.filter(a =>
    st(a) === 'active' && a._stageIdx >= 6
  ).length;

  // Funnel — each stage shows how many applicants ever reached it + currently active there
  const funnel = FUNNEL_STAGES.map((stage, i) => {
    const reached     = augmented.filter(a => a._stageIdx >= i);
    const atStage     = augmented.filter(a => a._stageIdx === i);
    const totalReached    = reached.length;
    const prevTotalReached = i === 0 ? total : augmented.filter(a => a._stageIdx >= i - 1).length;
    const passRate        = prevTotalReached > 0 ? totalReached / prevTotalReached : 1;

    // For the Hired stage, "active at stage" = total hired (they have status 'hired', not 'active')
    const isHiredStage = stage.key === 'hired';
    const activeAtStage = isHiredStage
      ? atStage.filter(a => st(a) === 'hired').length
      : atStage.filter(a => st(a) === 'active').length;

    return {
      stage: stage.label,
      key:   stage.key,
      totalReached,
      activeAtStage,
      archivedAtStage: atStage.filter(a => st(a) === 'archived').length,
      passRate,
    };
  });

  // Source breakdown — skip apps with no source data
  const sourceMap = new Map();
  let appsWithNoSource = 0;
  augmented.forEach(app => {
    const source = getSourceLabel(app);
    if (!source) { appsWithNoSource++; return; } // skip unknowns
    if (!sourceMap.has(source)) {
      sourceMap.set(source, { total: 0, hires: 0, active: 0, reachedInterview1: 0 });
    }
    const s = sourceMap.get(source);
    s.total++;
    if (st(app) === 'hired')  s.hires++;
    if (st(app) === 'active') s.active++;
    if (app._stageIdx >= 2)      s.reachedInterview1++;  // Interview 1 = index 2
  });

  const sources = [...sourceMap.entries()]
    .map(([name, d]) => ({
      name,
      total: d.total,
      hires: d.hires,
      active: d.active,
      interview1PassRate: d.total > 0 ? d.reachedInterview1 / d.total : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // Weekly velocity — last 4 rolling weeks
  const velocity = [];
  for (let i = 3; i >= 0; i--) {
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - i * 7);
    weekEnd.setHours(23, 59, 59, 999);

    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 6);
    weekStart.setHours(0, 0, 0, 0);

    const label = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const interviewsThisWeek = augmented.filter(app => {
      if (app._stageIdx < 2) return false;
      const d = new Date(getDateField(app, 'applicationDate', 'createdAt', 'appliedAt') || 0);
      return d >= weekStart && d <= weekEnd;
    }).length;

    const hiresThisWeek = augmented.filter(app => {
      if (st(app) !== 'hired') return false;
      const d = new Date(getDateField(app, 'hiredAt', 'hiredDate', 'updatedAt') || 0);
      return d >= weekStart && d <= weekEnd;
    }).length;

    velocity.push({ week: label, interviews: interviewsThisWeek, hires: hiresThisWeek });
  }

  // Get on Board specific stats (case-insensitive key search)
  const gobEntry = [...sourceMap.entries()].find(([k]) =>
    k.toLowerCase().includes('get on board') || k.toLowerCase().includes('getonboard')
  );
  const gobStats = gobEntry ? {
    source: gobEntry[0],
    total:  gobEntry[1].total,
    hires:  gobEntry[1].hires,
    active: gobEntry[1].active,
    interview1PassRate: gobEntry[1].total > 0
      ? gobEntry[1].reachedInterview1 / gobEntry[1].total : 0,
  } : null;

  // Referral
  const refEntry = [...sourceMap.entries()].find(([k]) => k.toLowerCase().includes('referral'));
  const referralHires = refEntry ? refEntry[1].hires : 0;

  // How much of the pipeline has source data (0–1)
  const sourceDataCoverage = total > 0 ? (total - appsWithNoSource) / total : 0;

  // Debug info — helps diagnose stage/status mismatches
  const statusValuesSeen = [...new Set(applications.map(a => a.status).filter(Boolean))].sort();
  const stageNamesSeen   = [...new Set(augmented.map(a => a._stageName).filter(Boolean))].sort();

  return {
    generatedAt: now.toISOString(),
    pipeline: { totalApplications: total, totalActive: active, totalLeads: leads, totalArchived: archived, totalHired: hired, pendingOffer },
    funnel,
    sources,
    sourceDataCoverage,
    velocity,
    overallConversion: total > 0 ? hired / total : 0,
    topSource: sources.length > 0 ? sources[0].name : 'N/A',
    gobStats,
    referralHires,
    referralShareOfHires: hired > 0 ? referralHires / hired : 0,
    benchmarks: BENCHMARKS,
    debug: { statusValuesSeen, stageNamesSeen },
  };
}

// ─── CORS helpers ─────────────────────────────────────────────────────────────

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

// ─── Pages Function handlers ─────────────────────────────────────────────────

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

export async function onRequestGet({ request, env, waitUntil }) {
  const cache = caches.default;
  const cacheKey = new Request('https://futureproofing-internal-cache/report-v19');

  // Serve from cache if available
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

    // Step 1: paginate job list (2 pages covers all 110 jobs in this org)
    const allJobs = [];
    let jobCursor;
    for (let p = 0; p < 3; p++) {
      const body = { includeArchived: true };
      if (jobCursor) body.cursor = jobCursor;
      const jobsData = await ashbyPost(apiKey, '/job.list', body);
      allJobs.push(...(jobsData.results || []));
      jobCursor = jobsData.nextCursor || null;
      if (!jobCursor) break;
    }

    // Step 2: match OPEN AI Engineer jobs — prefer Open status to avoid closed/contract jobs
    // Known: "AI Engineer" (Open, id 38202bf1...) is the main pipeline
    function isAIJob(j) {
      const t = (j.title || '').toLowerCase();
      return t.includes('ai engineer') || (t.includes('ai') && t.includes('software engineer'));
    }
    // Prefer Open jobs; fall back to all AI jobs if none are open
    let aiJobs = allJobs.filter(j => isAIJob(j) && (j.status || '').toLowerCase() === 'open');
    if (aiJobs.length === 0) {
      aiJobs = allJobs.filter(isAIJob);
    }

    // Step 3: fetch applications for each matched job (paginated, limit 100 per page)
    let allApplications = [];
    for (const job of aiJobs) {
      const apps = await getAllApplications(apiKey, { jobId: job.id });
      allApplications.push(...apps);
    }

    // Deduplicate by ID
    const seen = new Set();
    allApplications = allApplications.filter(a => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });

    const metrics = computeMetrics(allApplications);
    // Keep a lightweight debug summary (not full job lists)
    metrics.debug.matchedJobs = aiJobs.map(j => ({ id: j.id, title: j.title, status: j.status }));

    // ── Historical snapshots via KV ──────────────────────────────────────
    const kv = env.REPORTS_HISTORY;
    if (kv) {
      try {
        // Load existing history (array of up to 3 snapshots)
        const histRaw = await kv.get('history', 'json');
        const history = Array.isArray(histRaw) ? histRaw : [];

        // Attach the last 3 snapshots to the response for trend display
        metrics.history = history.slice(0, 3);

        // Build a compact snapshot of key metrics to store
        const snapshot = {
          ts:              metrics.generatedAt,
          totalActive:     metrics.pipeline.totalActive,
          totalHired:      metrics.pipeline.totalHired,
          totalArchived:   metrics.pipeline.totalArchived,
          totalApplications: metrics.pipeline.totalApplications,
          overallConversion: metrics.overallConversion,
          funnel: metrics.funnel.map(f => ({
            key:           f.key,
            stage:         f.stage,
            activeAtStage: f.activeAtStage,
            totalReached:  f.totalReached,
            passRate:      f.passRate,
          })),
          topSource:       metrics.topSource,
          referralHires:   metrics.referralHires,
        };

        // Prepend new snapshot, keep last 10 in KV (we only show 3 in UI)
        const updated = [snapshot, ...history].slice(0, 10);
        // Use await directly (not waitUntil) to ensure the write completes
        await kv.put('history', JSON.stringify(updated));
      } catch (kvErr) {
        console.error('[report] KV error:', kvErr.message);
        metrics.debug.kvError = kvErr.message; // expose for debugging
        // Non-fatal — continue without history
      }
    }

    const response = new Response(JSON.stringify(metrics, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(),
        'Cache-Control': 'public, max-age=300, s-maxage=300',
        'X-Cache': 'MISS',
      },
    });

    // Store in Cloudflare cache for 5 minutes
    waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  } catch (err) {
    console.error('[report] Error:', err.message);
    return jsonResponse({ error: err.message, timestamp: new Date().toISOString() }, 500);
  }
}
