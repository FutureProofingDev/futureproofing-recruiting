import { pollAllPipelines } from './poll.js';
import { PIPELINES } from './pipelines/index.js';
import {
  listCandidatesByPipeline,
  getCandidateById,
  getLatestStageEvaluations,
  getStageEvaluationHistory,
  getLatestFinalSummary,
  getLatestSnapshot,
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

async function listCandidates(env, url) {
  const pipelineKey = url.searchParams.get('pipeline');
  const pipelines = pipelineKey ? [pipelineKey] : PIPELINES.map(p => p.key);

  const candidates = [];
  for (const key of pipelines) {
    const rows = await listCandidatesByPipeline(env.DB, key);
    for (const row of rows) {
      const summary = await getLatestFinalSummary(env.DB, row.id);
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

  return { candidate, stageEvaluations, stageHistory, finalSummary };
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

  const instance = await env.EVAL_WORKFLOW.create({ params: { application, pipelineKey: candidate.pipeline_key } });
  return { instanceId: instance.id };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!authorized(request, env)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const candidateMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)(\/regenerate)?$/);

    if (url.pathname === '/api/candidates' && request.method === 'GET') {
      return json({ candidates: await listCandidates(env, url) });
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

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAllPipelines(env));
  },
};
