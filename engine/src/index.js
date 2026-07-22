import { pollAllPipelines } from './poll.js';
import { PIPELINES } from './pipelines/index.js';
import { getCandidateProfile, getResumeFileInfo } from './ashby/collectors.js';
import {
  listCandidatesByPipeline,
  getCandidateById,
  getLatestStageEvaluations,
  getStageEvaluationHistory,
  getLatestFinalSummary,
  getLatestSnapshot,
  insertManualNote,
  getLatestManualNote,
} from './db/repository.js';

export { CandidateEvaluationWorkflow } from './evaluation/workflow.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authorized(request, env) {
  return Boolean(env.ENGINE_INTERNAL_KEY) && request.headers.get('X-Engine-Key') === env.ENGINE_INTERNAL_KEY;
}

// Critical-but-easy-to-miss data points a recruiter should always be able to
// see are present or explicitly still pending — surfaced as a red flag in
// the UI (sidebar dot + a banner on the candidate's own page) rather than
// silently absent.
function computeDataGaps(snapshot, stageEvaluations) {
  const gaps = [];
  if (!snapshot?.payload?.salaryNotes?.length) gaps.push('salary');
  if (!stageEvaluations.some(e => e.stage_key === 'hackereval')) gaps.push('hackereval');
  return gaps;
}

async function listCandidates(env, url) {
  const pipelineKey = url.searchParams.get('pipeline');
  const pipelines = pipelineKey ? [pipelineKey] : PIPELINES.map(p => p.key);

  const candidates = [];
  for (const key of pipelines) {
    const rows = await listCandidatesByPipeline(env.DB, key);
    for (const row of rows) {
      const summary = await getLatestFinalSummary(env.DB, row.id);
      const snapshot = await getLatestSnapshot(env.DB, row.id);
      const stageEvaluations = await getLatestStageEvaluations(env.DB, row.id);
      candidates.push({
        id: row.id,
        name: row.name,
        email: row.email,
        jobTitle: row.job_title,
        pipelineKey: row.pipeline_key,
        currentStage: row.current_stage,
        updatedAt: row.updated_at,
        recommendation: summary?.recommendation || null,
        confidence: summary?.confidence || null,
        hasSummary: Boolean(summary),
        dataGaps: computeDataGaps(snapshot, stageEvaluations),
      });
    }
  }
  return candidates;
}

async function getCandidateDetail(env, id) {
  const candidate = await getCandidateById(env.DB, id);
  if (!candidate) return null;

  const stageEvaluations = await getLatestStageEvaluations(env.DB, id);
  const stageHistory = {};
  for (const ev of stageEvaluations) {
    stageHistory[ev.stage_key] = await getStageEvaluationHistory(env.DB, id, ev.stage_key);
  }
  const finalSummary = await getLatestFinalSummary(env.DB, id);

  // A manually-entered note (from a recruiter conversation) always wins —
  // it's verified, not inferred. Otherwise fall back to what the synthesis
  // step extracted from the feedback form's employment-history questions,
  // if those were asked and answered for this candidate. Otherwise null,
  // so the UI can show "we're still collecting this" instead of a blank.
  const manualNote = await getLatestManualNote(env.DB, id, 'employment_history');
  let employmentHistory = null;
  let employmentHistorySource = null;
  if (manualNote) {
    employmentHistory = manualNote.content;
    employmentHistorySource = 'manual';
  } else if (finalSummary?.output?.employmentHistoryExtract?.found) {
    const { found, ...rest } = finalSummary.output.employmentHistoryExtract;
    employmentHistory = rest;
    employmentHistorySource = 'auto';
  }

  // Only the filename comes from the cached snapshot (that never expires);
  // the actual download URL is fetched fresh on demand via /resume-url,
  // since Ashby's signed link is only valid ~30 minutes.
  const snapshot = await getLatestSnapshot(env.DB, id);
  const resumeName = snapshot?.payload?.resume?.name || null;
  const salaryNotes = snapshot?.payload?.salaryNotes || [];
  const dataGaps = computeDataGaps(snapshot, stageEvaluations);

  return { candidate, stageEvaluations, stageHistory, finalSummary, employmentHistory, employmentHistorySource, resumeName, salaryNotes, dataGaps };
}

// Ashby's file.info URL is a signed S3 link valid for only ~30 minutes —
// far too short to cache in the dossier snapshot and expect it to still
// work when someone clicks "View Resume" later. Fetch a fresh one on demand
// instead, right when it's actually needed.
async function getFreshResumeUrl(env, id) {
  const candidate = await getCandidateById(env.DB, id);
  if (!candidate?.ashby_candidate_id) return null;
  const profile = await getCandidateProfile(env.ASHBY_API_KEY, candidate.ashby_candidate_id);
  if (!profile?.resumeFileHandle) return null;
  return getResumeFileInfo(env.ASHBY_API_KEY, profile.resumeFileHandle);
}

// Manual regenerate: rebuilds a minimal Ashby application shape from the
// candidate row + its last cached dossier, then starts a fresh Workflow run.
// The collectors re-fetch everything live from Ashby by id — this shape is
// only a seed, not stale data being reused as the evaluation input.
async function regenerateCandidate(env, id) {
  const candidate = await getCandidateById(env.DB, id);
  if (!candidate) return null;
  const snapshot = await getLatestSnapshot(env.DB, id);

  const application = {
    id: candidate.ashby_application_id,
    candidate: {
      id: candidate.ashby_candidate_id,
      name: candidate.name,
      primaryEmailAddress: { value: candidate.email },
    },
    job: { title: candidate.job_title },
    currentInterviewStage: { title: snapshot?.payload?.currentStage || candidate.current_stage },
  };

  const instance = await env.EVAL_WORKFLOW.create({ params: { application, pipelineKey: candidate.pipeline_key, force: true } });
  return { instanceId: instance.id };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!authorized(request, env)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const candidateMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)(\/regenerate)?$/);
    const manualNoteMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)\/manual-notes\/([^/]+)$/);
    const resumeMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)\/resume-url$/);

    if (url.pathname === '/api/candidates' && request.method === 'GET') {
      return json({ candidates: await listCandidates(env, url) });
    }

    // Manual poll trigger — same logic as the cron, useful right after
    // registering a new pipeline/job match instead of waiting up to 10 min.
    if (url.pathname === '/api/poll-now' && request.method === 'POST') {
      return json({ result: await pollAllPipelines(env) });
    }

    if (resumeMatch && request.method === 'GET') {
      const resume = await getFreshResumeUrl(env, resumeMatch[1]);
      if (!resume) return json({ error: 'No resume on file' }, 404);
      return json(resume);
    }

    if (candidateMatch && !candidateMatch[2] && request.method === 'GET') {
      const detail = await getCandidateDetail(env, candidateMatch[1]);
      if (!detail) return json({ error: 'Not found' }, 404);
      return json(detail);
    }

    if (candidateMatch && candidateMatch[2] && request.method === 'POST') {
      const result = await regenerateCandidate(env, candidateMatch[1]);
      if (!result) return json({ error: 'Not found' }, 404);
      return json({ started: true, ...result });
    }

    // Manually entered data (e.g. employment history from a recruiter
    // conversation) that the Ashby-driven pipeline has no way to discover.
    // Append-only like everything else — POSTing again adds a new version,
    // the latest always wins for display.
    if (manualNoteMatch && request.method === 'POST') {
      const candidate = await getCandidateById(env.DB, manualNoteMatch[1]);
      if (!candidate) return json({ error: 'Not found' }, 404);
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: 'Expected a JSON body' }, 400);
      const id = await insertManualNote(env.DB, {
        candidateId: candidate.id,
        noteType: manualNoteMatch[2],
        content: body,
      });
      return json({ id });
    }

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAllPipelines(env));
  },
};
