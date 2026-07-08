// Cloudflare Pages Function — GET /api/talent
// Per-hired-person development tracker.
//  - Ashby ATS  → hired AI Engineers + their scorecard/feedback scores across stages
//  - Notion     → onboarding stage (from the "All Hiring Tracker" database)
//
// The Ashby + Notion keys live ONLY server-side. They are never exposed to the browser.
//
// Secrets / vars (set on the Pages project):
//   ASHBY_API_KEY       (secret)  — already configured for /api/report
//   NOTION_API_KEY      (secret)  — Notion internal integration token (starts with "ntn_" or "secret_")
//   NOTION_HIRES_DB_ID  (var)     — defaults to the "All Hiring Tracker" database id below
//
// Add a ?debug=1 query param to get the raw first-feedback payload so we can
// tighten the scorecard parser against your real Ashby data.

const ASHBY_BASE_URL  = 'https://api.ashbyhq.com';
const NOTION_BASE_URL = 'https://api.notion.com/v1';
const NOTION_VERSION  = '2022-06-28';

// Default Notion database: "Engineers" bench in the Dev/PM Tracker.
const DEFAULT_HIRES_DB_ID = '2f5ce9bd-fb9c-8092-9b87-fa02fcbf070e';

// Ordered onboarding pipeline — Notion "Weekly Update Stage" (select, 1→7).
const WEEKLY_STAGES = [
  '1 - Onboarding email',
  '2 - CIIAA sent',
  '3 - Slack & meetings access',
  '4 - Background check',
  '5 - Work references',
  '6 - Matching & contract',
  '7 - Contract signed',
];

// Post-contract milestones — Notion "Onboarding Stage" (multi-select checklist).
const ONBOARDING_MILESTONES = [
  'FP Welcome email',
  'Rippling access',
  'All Hands Meeting',
  'Client welcome email',
  'Client Presentations',
  'Background check',
  'Hired by Client',
];

// Position of a "N - ..." weekly stage value (1-based), or null.
function weeklyStageIndex(value) {
  if (!value) return null;
  const m = String(value).match(/^\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  const i = WEEKLY_STAGES.indexOf(value);
  return i >= 0 ? i + 1 : null;
}

// ─── Ashby helpers ────────────────────────────────────────────────────────────

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
        headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json' },
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
      if (res.status >= 400 && res.status < 500) throw new Error(`Ashby API ${endpoint}: ${msg}`);
      if (attempt === retries - 1) throw new Error(`Ashby API ${endpoint}: ${msg}`);
      continue;
    }
    return data;
  }
}

async function getAllApplications(apiKey, filter = {}) {
  const all = [];
  let cursor;
  for (let page = 0; page < 300; page++) {
    const body = { ...filter, limit: 100 };
    if (cursor) body.cursor = cursor;
    const data = await ashbyPost(apiKey, '/application.list', body);
    const results = Array.isArray(data.results) ? data.results : [];
    all.push(...results);
    cursor = data.nextCursor || null;
    if (!cursor) break;
  }
  return all;
}

// Run async fn over items with bounded concurrency (keeps Ashby rate limits happy).
async function mapLimit(items, limit, fn) {
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

function isAIJob(j) {
  const t = (j.title || '').toLowerCase();
  return t.includes('ai engineer') ||
         (t.includes('ai') && t.includes('software engineer')) ||
         (t.includes('ai') && t.includes('ml')) ||
         t.includes('applied ai');
}

// ─── Scorecard / feedback parsing ─────────────────────────────────────────────
// Ashby feedback shapes vary by org/form. We parse defensively: walk known field
// arrays, normalise scores to a 0–1 scale, and keep raw payloads for debugging.

// Map a qualitative rating string to a 0–1 score.
function ratingToScore(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().replace(/[_\s-]+/g, ' ').trim();
  const map = {
    'strong yes': 1, 'strong hire': 1, 'definitely': 1, 'exceptional': 1, 'excellent': 1,
    'yes': 0.78, 'hire': 0.78, 'good': 0.75, 'above average': 0.75, 'leaning yes': 0.65,
    'mixed': 0.5, 'maybe': 0.5, 'neutral': 0.5, 'average': 0.5, 'leaning no': 0.4,
    'no': 0.28, 'below average': 0.3, 'weak': 0.28, 'no hire': 0.25,
    'strong no': 0, 'strong no hire': 0, 'definitely not': 0, 'poor': 0.1,
  };
  if (s in map) return map[s];
  return null;
}

// Normalise a numeric score to 0–1, guessing the scale from its magnitude.
function numberToScore(n) {
  if (typeof n !== 'number' || isNaN(n)) return null;
  if (n <= 1) return Math.max(0, Math.min(1, n));   // already 0–1
  if (n <= 4) return (n - 1) / 3;                    // 1–4 scale
  if (n <= 5) return (n - 1) / 4;                    // 1–5 scale
  if (n <= 10) return n / 10;                        // 1–10 scale
  if (n <= 100) return n / 100;                      // percentage
  return null;
}

// Try to pull a 0–1 score out of an arbitrary field value.
function valueToScore(value) {
  if (value == null) return null;
  if (typeof value === 'number') return numberToScore(value);
  if (typeof value === 'string') {
    const asNum = Number(value);
    if (!isNaN(asNum) && value.trim() !== '') return numberToScore(asNum);
    return ratingToScore(value);
  }
  if (typeof value === 'object') {
    // Common nested shapes: { score }, { value }, { label }, { selectedOption: { label } }
    if (typeof value.score === 'number') return numberToScore(value.score);
    if (value.value != null && value.value !== value) return valueToScore(value.value);
    if (value.label) return ratingToScore(value.label);
    if (value.selectedOption?.label) return ratingToScore(value.selectedOption.label);
    if (Array.isArray(value.selectedOptions) && value.selectedOptions[0]?.label) {
      return ratingToScore(value.selectedOptions[0].label);
    }
  }
  return null;
}

// First integer found in a string ("4 - Good" → 4, "3" → 3), else null.
function leadingInt(s) {
  if (s == null) return null;
  const m = String(s).match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// Map each field path → its definition (title, type, selectableValues) from the form.
function buildFieldDefs(fb) {
  const map = new Map();
  const fd = fb.formDefinition || fb.submittedFormInstance?.formDefinition || {};
  const sections = Array.isArray(fd.sections) ? fd.sections
                 : Array.isArray(fd.fields) ? [{ fields: fd.fields }] : [];
  for (const sec of sections) {
    for (const item of (sec.fields || [])) {
      const f = item.field || item;
      if (f && f.path) map.set(f.path, f);
    }
  }
  return map;
}

// Convert a submitted value to 0–1 using the field's real scale (selectableValues).
function scoreFromField(rawVal, def) {
  if (rawVal == null || rawVal === '') return null;
  const opts = def && Array.isArray(def.selectableValues) ? def.selectableValues : null;
  if (opts && opts.length) {
    const nums = opts.map(o => leadingInt(o.value) ?? leadingInt(o.label)).filter(n => n != null);
    const max = nums.length ? Math.max(...nums) : opts.length;
    const min = nums.length ? Math.min(...nums) : 1;
    let n = leadingInt(rawVal);
    if (n == null) {
      const opt = opts.find(o => o.value === rawVal || o.label === rawVal);
      if (opt) n = leadingInt(opt.value) ?? leadingInt(opt.label) ?? (opts.indexOf(opt) + 1);
    }
    if (n == null || max === min) return null;
    return Math.max(0, Math.min(1, (n - min) / (max - min)));
  }
  // Skip free-text / non-score field types.
  if (def && /text|richtext|string|email|url|date|boolean/i.test(def.type || '')) return null;
  // Fallback: a bare numeric value with an unknown scale.
  const n = leadingInt(rawVal);
  return n == null ? null : numberToScore(n);
}

function cleanTitle(t) {
  return String(t || '').replace(/�/g, '').replace(/\s+/g, ' ').trim();
}

function feedbackDate(fb) {
  return fb.submittedAt || fb.completedAt || fb.createdAt || fb.updatedAt ||
         fb.submittedFormInstance?.submittedAt || null;
}

function feedbackStage(fb, fallback) {
  return fb.interviewStage?.title || fb.interviewStage?.name ||
         fb.interview?.title || fb.interviewEvent?.title ||
         fb.stage?.title || fb.stage ||
         fb.submittedFormInstance?.formDefinition?.title ||
         fb.formDefinition?.title || fallback || 'Evaluation';
}

// Build one evaluation object from a feedback submission.
function parseFeedback(fb, fallbackStage) {
  const defs = buildFieldDefs(fb);
  const submitted = (fb.submittedValues && typeof fb.submittedValues === 'object' && !Array.isArray(fb.submittedValues))
    ? fb.submittedValues : {};
  const attributes = [];
  let overall = null;

  for (const [path, rawVal] of Object.entries(submitted)) {
    const def = defs.get(path);
    const score = scoreFromField(rawVal, def);
    if (score == null) continue;
    const title = cleanTitle((def && (def.title || def.humanReadablePath)) || path);
    if (path === 'overall_recommendation' || /overall recommendation/i.test(title)) {
      overall = score;
    } else {
      attributes.push({ name: title, score });
    }
  }

  if (overall == null && attributes.length) {
    overall = attributes.reduce((s, a) => s + a.score, 0) / attributes.length;
  }

  return {
    stage: feedbackStage(fb, fallbackStage),
    date: feedbackDate(fb),
    overall,
    attributes,
  };
}

async function getFeedbackForApplication(apiKey, applicationId) {
  // Try the documented endpoint; fall back gracefully if the org doesn't expose it.
  for (const endpoint of ['/applicationFeedback.list', '/feedback.list']) {
    try {
      const data = await ashbyPost(apiKey, endpoint, { applicationId }, 2);
      const results = Array.isArray(data.results) ? data.results
                    : Array.isArray(data.feedback) ? data.feedback : [];
      if (results.length) return results;
    } catch {
      // try next endpoint
    }
  }
  return [];
}

async function getNotesForCandidate(apiKey, candidateId) {
  // HackerEval evaluations are posted as candidate notes in Ashby.
  if (!candidateId) return [];
  try {
    const data = await ashbyPost(apiKey, '/candidate.listNotes', { candidateId, limit: 100 }, 2);
    return Array.isArray(data.results) ? data.results
         : Array.isArray(data.notes) ? data.notes : [];
  } catch {
    return [];
  }
}

// ─── HackerEval (Ashby notes) parsing ─────────────────────────────────────────
// HackerEval evaluations live in Ashby application notes. The exact wording
// varies, so we parse defensively and keep raw notes available via ?debug=1.

function noteText(note) {
  // Ashby note content shows up under various keys, sometimes as HTML.
  const raw = note.content || note.note || note.body || note.text ||
              note.value || (typeof note === 'string' ? note : '') || '';
  return String(raw).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function noteDate(note) {
  return note.createdAt || note.submittedAt || note.updatedAt || note.date || null;
}

// Tech-assessment / HackerRank results are logged as free-text candidate notes
// (usually a Google Drive link to the results, sometimes a "completed at NN%" line).
const TECH_ASSESS_RE = /hacker\s*rank|hacker\s*eval|tech(nical)?\s*(test|assessment)|coding\s*(test|challenge|assessment)|tech\s*test/i;

function extractTechAssessment(notes) {
  const items = [];
  for (const n of notes || []) {
    const t = noteText(n);
    if (!t || !TECH_ASSESS_RE.test(t)) continue;
    const url = (t.match(/https?:\/\/[^\s)]+/) || [null])[0];
    const pctM = t.match(/(\d{1,3})\s*%/);
    const pct = pctM ? Math.min(100, parseInt(pctM[1], 10)) : null;
    items.push({ date: noteDate(n), text: t.slice(0, 220), url, pct });
  }
  items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return { found: items.length > 0, items: items.slice(0, 6) };
}

// Short date label ("Nov 3") for chart axes; falls back to an index.
function shortDate(d, i) {
  if (!d) return `Eval ${i + 1}`;
  const t = new Date(d);
  if (isNaN(t)) return `Eval ${i + 1}`;
  return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Notion helpers ───────────────────────────────────────────────────────────

async function notionQueryHires(token, dbId) {
  const all = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`${NOTION_BASE_URL}/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.message || msg; } catch {}
      throw new Error(`Notion: ${msg}`);
    }
    const data = await res.json();
    all.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return all;
}

function plainText(rich) {
  if (!Array.isArray(rich)) return '';
  return rich.map(r => r.plain_text || '').join('').trim();
}

// Extract a hire record from a Notion "Engineers" page (known schema).
function parseHireRecord(page) {
  const props = page.properties || {};
  const get = (name) => props[name];
  const titleProp = Object.values(props).find(p => p && p.type === 'title');

  const nameProp = get('Candidate Name');
  const name = nameProp?.type === 'title' ? plainText(nameProp.title)
             : (titleProp ? plainText(titleProp.title) : '');
  const email = get('Candidate Email')?.email || null;
  const weekly = get('Weekly Update Stage')?.select?.name || null;
  const milestones = (get('Onboarding Stage')?.multi_select || []).map(o => o.name);
  const readiness = get('AI Tooling (Cursor, Copilot, etc) 1')?.status?.name || null;
  const placement = (get('Client Placement')?.multi_select || [])
    .map(o => o.name).filter(n => n && n !== 'None');

  return { name, email, weekly, milestones, readiness, placement };
}

// Normalise a name for fuzzy matching (lowercase, strip accents/punctuation).
function normName(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function buildOnboarding(rec) {
  // Ordered pipeline from "Weekly Update Stage".
  const wk = rec ? weeklyStageIndex(rec.weekly) : null; // 1..7 or null
  const steps = WEEKLY_STAGES.map((label, i) => ({
    label: label.replace(/^\d+\s*-\s*/, ''),
    done:    wk != null && (i + 1) < wk,
    current: wk != null && (i + 1) === wk,
  }));
  const pct = wk == null ? 0 : Math.round((wk / WEEKLY_STAGES.length) * 100);

  // Milestone checklist from "Onboarding Stage" (multi-select).
  const doneSet = new Set((rec?.milestones || []).map(m => m.toLowerCase()));
  const milestones = ONBOARDING_MILESTONES.map(m => ({ label: m, done: doneSet.has(m.toLowerCase()) }));

  return {
    matched: Boolean(rec),
    stage: rec?.weekly || null,
    status: rec?.weekly ? rec.weekly.replace(/^\d+\s*-\s*/, '') : (rec ? 'No stage set' : 'Not found in Notion'),
    stepIndex: wk == null ? -1 : wk - 1,
    totalSteps: WEEKLY_STAGES.length,
    pct,
    steps,
    milestones,
    milestonesDone: milestones.filter(m => m.done).length,
    milestonesTotal: ONBOARDING_MILESTONES.length,
    readiness: rec?.readiness || null,
    placement: rec?.placement || [],
  };
}

// ─── Metrics assembly ─────────────────────────────────────────────────────────

function buildPerson(app, job, feedbacks, notes) {
  const candidate = app.candidate || {};
  const name = candidate.name || app.name ||
               [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') || 'Unknown';

  // Evaluations with real scores come from Ashby scorecards.
  const evaluations = feedbacks
    .map(fb => parseFeedback(fb, app.currentInterviewStage?.title))
    .filter(e => e.overall != null || e.attributes.length);

  // Tech assessment (HackerRank / tech test) — link + % logged in candidate notes.
  const techAssessment = extractTechAssessment(notes || []);

  // Sort chronologically for the progress trend.
  evaluations.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));

  // Progress trend = overall score per evaluation, in order (stage names aren't on
  // feedback, so label by date when the stage is generic).
  const progress = evaluations.map((e, i) => ({
    label: (e.stage && !/^(hired|evaluation)$/i.test(e.stage)) ? e.stage : shortDate(e.date, i),
    date: e.date,
    score: e.overall != null ? e.overall
         : (e.attributes.reduce((s, a) => s + a.score, 0) / (e.attributes.length || 1)),
  }));

  // Aggregate per-attribute (competency) across all evaluations.
  const compMap = new Map();
  for (const e of evaluations) {
    for (const a of e.attributes) {
      const key = a.name.trim();
      if (!compMap.has(key)) compMap.set(key, { name: key, sum: 0, count: 0, last: a.score });
      const c = compMap.get(key);
      c.sum += a.score; c.count += 1; c.last = a.score;
    }
  }
  const competencies = [...compMap.values()]
    .map(c => ({ name: c.name, score: c.sum / c.count, count: c.count, last: c.last }))
    .sort((a, b) => b.score - a.score);

  // Coaching points = the weakest competencies (avg below 0.6), worst first.
  const coaching = competencies
    .filter(c => c.score < 0.6)
    .sort((a, b) => a.score - b.score)
    .map(c => ({
      name: c.name,
      score: c.score,
      severity: c.score < 0.4 ? 'flag' : 'mixed',
    }));

  // Improvement delta = last overall vs first overall.
  let delta = null;
  if (progress.length >= 2) {
    delta = progress[progress.length - 1].score - progress[0].score;
  }

  return {
    applicationId: app.id,
    candidateId: candidate.id || null,
    name,
    email: candidate.primaryEmailAddress?.value || candidate.email || null,
    role: job?.title || app.job?.title || 'AI Engineer',
    source: (app.source && (app.source.title || app.source)) || null,
    hiredAt: app.hiredAt || app.updatedAt || null,
    evalCount: evaluations.length,
    avgScore: progress.length ? progress.reduce((s, p) => s + p.score, 0) / progress.length : null,
    delta,
    progress,
    competencies,
    coaching,
    techAssessment,
    evaluations,
    onboarding: null,   // filled in after Notion lookup
    coachingForm: null, // filled in after coaching-sheet lookup
  };
}

// ─── Coaching self-assessment form (Google Sheet, published as CSV) ───────────
// One published-CSV per role. The Worker reads it server-side (the URL is never
// exposed to the browser). Add future roles by adding an entry here.
const COACHING_SHEETS = [
  {
    match: /ai|ml|engineer/i,
    url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQtq6oC2vx9cvkJq2Tp6jQbESrR784fNiDN1np-PTdOWBawiZsGxm7oNfSt2SN_rr0JMBXLXsQYcdxs/pub?gid=2102097098&single=true&output=csv',
  },
];

function coachingSourceForRole(role) {
  const r = role || '';
  for (const s of COACHING_SHEETS) if (s.match.test(r)) return s.url;
  return null;
}

// Minimal RFC-4180 CSV parser (handles quoted fields with commas / newlines).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Rough 0–1 score from a self-rating value, when it looks numeric/scaled.
function ratingScore01(v) {
  if (!v) return null;
  const n = leadingInt(v);
  if (n != null && n >= 1 && n <= 5) return (n - 1) / 4;
  const s = v.toLowerCase();
  const words = { novice: 0, beginner: 0.25, basic: 0.25, intermediate: 0.5,
                  proficient: 0.7, advanced: 0.75, expert: 1, 'no experience': 0 };
  for (const k in words) if (s.includes(k)) return words[k];
  return null;
}

// Turn one CSV response row into a structured coaching record.
function buildCoachingResponse(header, row) {
  const idx = (name) => header.indexOf(name);
  const get = (name) => { const i = idx(name); return i >= 0 ? (row[i] || '').trim() : ''; };
  const META = new Set(['Timestamp', 'Email Address', 'Your name', 'Name', 'Email']);
  const wantsCol = header.find(h => /most want coaching|want coaching on/i.test(h));

  const categories = [];
  let cur = null;
  for (let i = 0; i < header.length; i++) {
    const h = (header[i] || '').trim();
    const v = (row[i] || '').trim();
    if (META.has(h) || h === wantsCol || !h) continue;
    const ev = h.match(/^Evidence\s*[—\-–]\s*(.+?)\s*(\(optional\))?$/i);
    if (ev) {
      if (!cur) cur = { name: ev[1].trim(), skills: [] };
      cur.name = ev[1].trim();
      cur.evidence = v || null;
      if (cur.skills.length || cur.evidence) categories.push(cur);
      cur = null;
    } else {
      if (!cur) cur = { name: null, skills: [] };
      if (v) cur.skills.push({ name: h, rating: v, score: ratingScore01(v) });
    }
  }
  if (cur && cur.skills.length) categories.push(cur);

  return {
    email: (get('Email Address') || get('Email')).toLowerCase().trim(),
    name: get('Your name') || get('Name'),
    submittedAt: get('Timestamp') || null,
    wants: wantsCol ? get(wantsCol) : '',
    categories,
  };
}

async function fetchCoachingMap(url) {
  let res;
  try { res = await fetch(url, { cf: { cacheTtl: 300 } }); }
  catch { return null; }
  if (!res.ok) return null;
  const text = await res.text();
  if (/<!DOCTYPE html|<html/i.test(text.slice(0, 200))) return null; // login wall, not CSV
  const rows = parseCsv(text);
  if (rows.length < 2) return { byEmail: new Map(), byName: new Map(), count: 0 };
  const header = rows[0];
  const byEmail = new Map(), byName = new Map();
  for (const r of rows.slice(1)) {
    if (!r.some(c => (c || '').trim())) continue;
    const rec = buildCoachingResponse(header, r);
    if (rec.email) byEmail.set(rec.email, rec);
    if (rec.name) byName.set(normName(rec.name), rec);
  }
  return { byEmail, byName, count: byEmail.size || byName.size };
}

// ─── HTTP plumbing ────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...extra },
  });
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

export async function onRequestGet({ request, env, waitUntil }) {
  const url   = new URL(request.url);
  const debug = url.searchParams.get('debug') === '1';
  const fresh = url.searchParams.get('fresh') === '1';

  const cache = caches.default;
  const cacheKey = new Request('https://futureproofing-internal-cache/talent-v2');
  if (!fresh && !debug) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      Object.entries(corsHeaders()).forEach(([k, v]) => resp.headers.set(k, v));
      resp.headers.set('X-Cache', 'HIT');
      return resp;
    }
  }

  try {
    const apiKey = env.ASHBY_API_KEY;
    if (!apiKey) throw new Error('ASHBY_API_KEY is not set');

    const dbg = { matchedJobs: [], notionStagesSeen: [], notionRecordCount: 0, coachingResponses: 0, feedbackSample: null, noteSamples: [], errors: [] };

    // 1) Find AI Engineer jobs (prefer open).
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
    let aiJobs = allJobs.filter(j => isAIJob(j) && (j.status || '').toLowerCase() === 'open');
    if (!aiJobs.length) aiJobs = allJobs.filter(isAIJob);
    dbg.matchedJobs = aiJobs.map(j => ({ id: j.id, title: j.title, status: j.status }));

    // 2) Gather hired applications.
    const jobById = new Map(aiJobs.map(j => [j.id, j]));
    // Fetch ONLY hired applications per job (status filter avoids paginating the whole pipeline).
    const perJob = await Promise.all(aiJobs.map(job => getAllApplications(apiKey, { jobId: job.id, status: 'Hired' })));
    let hiredApps = perJob.flat().filter(a => (a.status || '').toLowerCase() === 'hired');
    // Deduplicate by application id.
    const seen = new Set();
    hiredApps = hiredApps.filter(a => (seen.has(a.id) ? false : seen.add(a.id)));

    // 3) Feedback + HackerEval notes per application → build people.
    //    Bounded concurrency: fetch both per app in parallel, 5 apps at a time.
    const people = await mapLimit(hiredApps, 5, async (app) => {
      const [feedbacks, notes] = await Promise.all([
        getFeedbackForApplication(apiKey, app.id),
        getNotesForCandidate(apiKey, app.candidate?.id),
      ]);
      if (debug) {
        if (!dbg.feedbackSample && feedbacks.length) dbg.feedbackSample = feedbacks[0];
        for (const n of notes) {
          const t = noteText(n);
          if (t && dbg.noteSamples.length < 80) dbg.noteSamples.push(t.slice(0, 180));
        }
      }
      return buildPerson(app, jobById.get(app.jobId) || app.job, feedbacks, notes);
    });

    // 4) Notion onboarding lookup.
    const notionToken = env.NOTION_API_KEY;
    const dbId = (env.NOTION_HIRES_DB_ID || DEFAULT_HIRES_DB_ID).replace(/-/g, '');
    let notionConfigured = Boolean(notionToken);
    let hireRecords = [];
    if (notionConfigured) {
      try {
        const pages = await notionQueryHires(notionToken, dbId);
        hireRecords = pages.map(parseHireRecord).filter(r => r.name || r.email);
        dbg.notionStagesSeen = [...new Set(hireRecords.map(r => r.weekly).filter(Boolean))];
        dbg.notionRecordCount = hireRecords.length;
      } catch (e) {
        dbg.errors.push(e.message);
        notionConfigured = false;
      }
    }

    for (const person of people) {
      let rec = null;
      if (notionConfigured) {
        // Prefer matching by email (most reliable), then by fuzzy name.
        const email = (person.email || '').toLowerCase().trim();
        if (email) rec = hireRecords.find(r => (r.email || '').toLowerCase().trim() === email) || null;
        if (!rec) {
          const target = normName(person.name);
          rec = hireRecords.find(r => {
            const rn = normName(r.name);
            return rn && target && (rn === target || rn.includes(target) || target.includes(rn));
          }) || null;
        }
      }
      person.onboarding = buildOnboarding(rec);
      person.onboarding.notionConfigured = notionConfigured;
    }

    // Coaching self-assessment form (per role → published Google Sheet CSV).
    const coachByUrl = new Map();
    for (const person of people) {
      const url = coachingSourceForRole(person.role);
      if (!url) continue;
      if (!coachByUrl.has(url)) coachByUrl.set(url, await fetchCoachingMap(url));
      const map = coachByUrl.get(url);
      if (!map) continue;
      const email = (person.email || '').toLowerCase().trim();
      person.coachingForm = (email && map.byEmail.get(email)) || map.byName.get(normName(person.name)) || null;
    }
    dbg.coachingResponses = [...coachByUrl.values()].reduce((s, m) => s + (m?.count || 0), 0);

    // Sort: most recently hired first.
    people.sort((a, b) => new Date(b.hiredAt || 0) - new Date(a.hiredAt || 0));

    const payload = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalHired: people.length,
        withEvaluations: people.filter(p => p.evalCount > 0).length,
        avgEvaluations: people.length
          ? +(people.reduce((s, p) => s + p.evalCount, 0) / people.length).toFixed(1) : 0,
        improving: people.filter(p => (p.delta || 0) > 0.02).length,
        needCoaching: people.filter(p => p.coaching.length).length,
        techTested: people.filter(p => p.techAssessment?.found).length,
        coachingForms: people.filter(p => p.coachingForm).length,
        notionConnected: notionConfigured,
      },
      people,
      debug: debug ? dbg : { matchedJobs: dbg.matchedJobs, notionStagesSeen: dbg.notionStagesSeen, errors: dbg.errors },
    };

    if (debug) return jsonResponse(payload, 200, { 'X-Cache': 'BYPASS' });

    const response = jsonResponse(payload, 200, {
      'Cache-Control': 'public, max-age=600, s-maxage=600',
      'X-Cache': 'MISS',
    });
    waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return jsonResponse({ error: err.message, timestamp: new Date().toISOString() }, 500);
  }
}
