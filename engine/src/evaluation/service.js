// Core orchestration, deliberately split into small, independently retryable
// functions — the Workflow (./workflow.js) wraps each one in its own
// step.do() so a single failing LLM call doesn't re-run everything before it.

import { buildDossier } from '../ashby/dossier.js';
import { groupFeedbackByStage } from '../ashby/collectors.js';
import { getPipeline } from '../pipelines/index.js';
import { getStagePrompt, SYNTHESIS_PROMPT } from '../llm/prompts/index.js';
import { buildStageEvalTool } from '../llm/schemas/stageEval.js';
import { buildSynthesisTool } from '../llm/schemas/synthesis.js';
import { generateStructured } from '../llm/client.js';
import { hashJson } from '../util/hash.js';
import { slugify } from '../util/slug.js';
import {
  upsertCandidate,
  insertRawSnapshot,
  getLatestStageEvaluations,
  insertStageEvaluation,
  getLatestFinalSummary,
  insertFinalSummary,
} from '../db/repository.js';

// Step 1: refresh the candidate row + fetch a full Ashby dossier + cache it.
export async function syncCandidateAndDossier(env, application, pipelineKey) {
  const pipeline = getPipeline(pipelineKey);
  const { dossier, contentHash } = await buildDossier(env.ASHBY_API_KEY, application);

  const candidate = await upsertCandidate(env.DB, {
    ashbyApplicationId: String(application.id),
    ashbyCandidateId: application.candidate?.id ? String(application.candidate.id) : null,
    pipelineKey: pipeline.key,
    name: dossier.name,
    email: dossier.email,
    jobTitle: dossier.jobTitle,
    currentStage: dossier.currentStage,
  });

  await insertRawSnapshot(env.DB, { candidateId: candidate.id, contentHash, payload: dossier });

  return { candidateId: candidate.id, dossier, contentHash };
}

// Which interview transcripts (if any) belong to a given scorecard stage title.
function transcriptsForStage(dossier, stageTitle) {
  return (dossier.notetakerTranscripts || []).filter(t =>
    (t.interviewTitle || '').toLowerCase().includes((stageTitle || '').toLowerCase())
  );
}

// Step 2: diff the dossier's evidence against what's already stored to find
// which stage evaluations are missing or stale (new data, or a bumped
// prompt version). Read-only — does not call the LLM.
export async function determineStageWork(env, candidateId, pipelineKey, dossier) {
  const pipeline = getPipeline(pipelineKey);
  const existing = await getLatestStageEvaluations(env.DB, candidateId);
  const existingByKey = new Map(existing.map(e => [e.stage_key, e]));

  const candidates = [];

  const feedbackGroups = groupFeedbackByStage(dossier.feedback);
  for (const [title, items] of feedbackGroups) {
    const stageDef = pipeline.stages.find(s => s.sourceType === 'feedback' && s.match?.(title));
    candidates.push({
      stageKey: stageDef ? stageDef.key : slugify(title),
      stageName: stageDef ? stageDef.label : title,
      evalType: stageDef ? stageDef.evalType : pipeline.fallbackEvalType,
      evidence: { feedbackItems: items, stageName: title, transcripts: transcriptsForStage(dossier, title) },
    });
  }

  const techStageDef = pipeline.stages.find(s => s.sourceType === 'techAssessment');
  if (techStageDef && dossier.techAssessment?.length) {
    candidates.push({
      stageKey: techStageDef.key,
      stageName: techStageDef.label,
      evalType: techStageDef.evalType,
      evidence: { techAssessmentItems: dossier.techAssessment },
    });
  }

  const work = [];
  for (const c of candidates) {
    const inputHash = await hashJson(c.evidence);
    const promptVersion = getStagePrompt(c.evalType).version;
    const prior = existingByKey.get(c.stageKey);
    const isStale = !prior || prior.input_hash !== inputHash || prior.prompt_version !== promptVersion;
    if (isStale) work.push({ ...c, inputHash, promptVersion });
  }
  return work;
}

// Step 3 (one call per stage needing work): generate + persist one stage evaluation.
export async function generateAndStoreStageEvaluation(env, candidateId, pipelineKey, dossier, work) {
  const pipeline = getPipeline(pipelineKey);
  const competencyKeys = pipeline.competencies.map(c => c.key);
  const promptModule = getStagePrompt(work.evalType);
  const tool = buildStageEvalTool(work.evalType, competencyKeys);
  const { system, prompt } = promptModule.buildPrompt(dossier, competencyKeys, work.evidence);

  const output = await generateStructured(env, { system, prompt, tool, model: env.ANTHROPIC_MODEL });

  const id = await insertStageEvaluation(env.DB, {
    candidateId,
    stageKey: work.stageKey,
    stageName: work.stageName,
    evalType: work.evalType,
    promptVersion: work.promptVersion,
    model: env.ANTHROPIC_MODEL,
    inputHash: work.inputHash,
    output,
  });

  return { id, stageKey: work.stageKey };
}

// Step 4: once all currently-available stage evaluations are up to date,
// synthesize (or refresh) the Final Candidate Summary. Skips the LLM call
// entirely if nothing has changed since the last synthesis.
export async function generateAndStoreSynthesis(env, candidateId, pipelineKey, dossier) {
  const pipeline = getPipeline(pipelineKey);
  const stageEvaluations = await getLatestStageEvaluations(env.DB, candidateId);
  if (!stageEvaluations.length) return null;

  const competencyKeys = pipeline.competencies.map(c => c.key);
  const inputHash = await hashJson(
    stageEvaluations.map(e => ({ stageKey: e.stage_key, output: e.output, promptVersion: e.prompt_version }))
  );

  const prior = await getLatestFinalSummary(env.DB, candidateId);
  const isStale = !prior || prior.input_hash !== inputHash || prior.prompt_version !== SYNTHESIS_PROMPT.version;
  if (!isStale) return { id: prior.id, skipped: true };

  const tool = buildSynthesisTool(competencyKeys);
  const { system, prompt } = SYNTHESIS_PROMPT.buildPrompt(dossier, competencyKeys, { stageEvaluations });
  const output = await generateStructured(env, { system, prompt, tool, model: env.ANTHROPIC_MODEL });

  const id = await insertFinalSummary(env.DB, {
    candidateId,
    basedOnEvaluationIds: stageEvaluations.map(e => e.id),
    inputHash,
    promptVersion: SYNTHESIS_PROMPT.version,
    model: env.ANTHROPIC_MODEL,
    output,
    recommendation: output.finalRecommendation,
    confidence: output.confidenceLevel,
  });

  return { id, skipped: false };
}
