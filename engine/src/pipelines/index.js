import { aiEngineerPipeline } from './ai-engineer.js';

// Registry of every pipeline the engine evaluates. Onboarding a new job
// family = write a new file next to ai-engineer.js and add it here.
export const PIPELINES = [aiEngineerPipeline];

export function getPipeline(key) {
  return PIPELINES.find(p => p.key === key) || null;
}

// Which registered pipeline (if any) a given job title belongs to.
export function matchPipelineForJob(jobTitle) {
  return PIPELINES.find(p => p.matchesJob(jobTitle)) || null;
}
