// Cron entry point. No inbound webhook in v1 — this periodically asks Ashby
// who's at (or recently was at) each registered pipeline's trigger stage and
// starts an evaluation Workflow run for them. Re-triggering an
// already-processed candidate is safe and cheap: the Workflow's own
// hash-based staleness checks (see evaluation/service.js) only call the LLM
// again if something actually changed since the last run.

import { listJobs, listApplicationsForJob } from './ashby/collectors.js';
import { PIPELINES } from './pipelines/index.js';
import { listCandidatesByPipeline, setPollState } from './db/repository.js';

function currentStageTitle(app) {
  if ((app.status || '').toLowerCase() === 'hired') return 'Hired';
  return app.currentInterviewStage?.title || app.applicationStage?.title || null;
}

export async function pollAllPipelines(env) {
  const summary = [];
  for (const pipeline of PIPELINES) {
    const result = await pollPipeline(env, pipeline);
    summary.push({ pipeline: pipeline.key, ...result });
  }
  return summary;
}

async function pollPipeline(env, pipeline) {
  const apiKey = env.ASHBY_API_KEY;
  const lookbackDays = Number(env.POLL_LOOKBACK_DAYS || 30);

  const allJobs = await listJobs(apiKey, { includeArchived: false });
  const matchedJobs = allJobs.filter(j => pipeline.matchesJob(j.title));

  let applications = [];
  for (const job of matchedJobs) {
    const apps = await listApplicationsForJob(apiKey, job.id, { status: 'Active' });
    applications.push(...apps);
  }
  const seen = new Set();
  applications = applications.filter(a => (seen.has(a.id) ? false : seen.add(a.id)));

  // Candidates we're already tracking for this pipeline that reached the
  // trigger stage recently — kept in the run even if they've since moved on,
  // so late-arriving feedback still triggers a refresh.
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const tracked = await listCandidatesByPipeline(env.DB, pipeline.key);
  const recentlyTrackedIds = new Set(
    tracked.filter(c => c.first_seen_at_trigger_stage && c.first_seen_at_trigger_stage >= cutoff)
      .map(c => c.ashby_application_id)
  );

  const relevant = applications.filter(app =>
    pipeline.triggerStage.match(currentStageTitle(app)) || recentlyTrackedIds.has(String(app.id))
  );

  let started = 0;
  for (const application of relevant) {
    await env.EVAL_WORKFLOW.create({ params: { application, pipelineKey: pipeline.key } });
    started++;
  }

  await setPollState(env.DB, pipeline.key);
  return { matchedJobs: matchedJobs.length, candidatesConsidered: applications.length, workflowsStarted: started };
}
