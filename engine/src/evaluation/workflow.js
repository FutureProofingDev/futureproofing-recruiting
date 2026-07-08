import { WorkflowEntrypoint } from 'cloudflare:workers';
import {
  syncCandidateAndDossier,
  determineStageWork,
  generateAndStoreStageEvaluation,
  generateAndStoreSynthesis,
} from './service.js';

// Durable, multi-step candidate evaluation run. Each step is retried
// independently by the Workflows runtime (default backoff/retry policy) and
// memoized — if the instance is interrupted, completed steps aren't re-run.
export class CandidateEvaluationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { application, pipelineKey, force = false } = event.payload;

    const { candidateId, dossier } = await step.do('sync-candidate-and-dossier', () =>
      syncCandidateAndDossier(this.env, application, pipelineKey)
    );

    const stageWork = await step.do('determine-stage-work', () =>
      determineStageWork(this.env, candidateId, pipelineKey, dossier, force)
    );

    for (const work of stageWork) {
      await step.do(`generate-stage-evaluation:${work.stageKey}`, () =>
        generateAndStoreStageEvaluation(this.env, candidateId, pipelineKey, dossier, work)
      );
    }

    const synthesis = await step.do('generate-final-summary', () =>
      generateAndStoreSynthesis(this.env, candidateId, pipelineKey, dossier, force)
    );

    return { candidateId, stagesEvaluated: stageWork.map(w => w.stageKey), synthesis };
  }
}
