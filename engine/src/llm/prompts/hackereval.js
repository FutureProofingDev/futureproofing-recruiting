import { BASE_SYSTEM_PROMPT, candidateContextBlock } from './shared.js';

export const version = 'hackereval.v1';

export function buildPrompt(dossier, competencyKeys, { techAssessmentItems }) {
  const system = `${BASE_SYSTEM_PROMPT}

You are evaluating HACKEREVAL / technical-assessment results specifically. These arrive as free-text notes
(often a link to results and/or a completion percentage) rather than a structured scorecard — read them
carefully and don't over-infer beyond what's stated. Competencies this pipeline tracks: ${competencyKeys.join(', ')}.`;

  const prompt = `${candidateContextBlock(dossier)}

HackerEval / technical-assessment notes found for this candidate (raw, JSON):
${JSON.stringify(techAssessmentItems, null, 2)}

Produce the structured HackerEval evaluation via the tool call.`;

  return { system, prompt };
}
