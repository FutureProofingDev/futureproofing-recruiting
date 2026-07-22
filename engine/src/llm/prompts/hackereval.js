import { BASE_SYSTEM_PROMPT, candidateContextBlock } from './shared.js';

export const version = 'hackereval.v3';

export function buildPrompt(dossier, competencyKeys, { techAssessmentItems, feedbackItems }) {
  const system = `${BASE_SYSTEM_PROMPT}

You are evaluating HACKEREVAL / technical-assessment results specifically. This evidence comes in two possible
forms: free-text notes (often a link to results and/or a completion percentage), and/or a structured scorecard
submission (evaluatorName + field titles/values) — use whichever is present, and both if both are present. Read
carefully and don't over-infer beyond what's stated. Every evidence item you cite must include which of the two
sources it came from (use the scorecard's evaluatorName + field title when citing that source). Competencies
this pipeline tracks: ${competencyKeys.join(', ')}.`;

  const prompt = `${candidateContextBlock(dossier)}

HackerEval / technical-assessment free-text notes found for this candidate (JSON, may be empty):
${JSON.stringify(techAssessmentItems || [], null, 2)}

HackerEval / technical-assessment scorecard submissions found for this candidate, simplified to the real
evaluator name and real field titles (JSON, may be empty):
${JSON.stringify(feedbackItems || [], null, 2)}

Produce the structured HackerEval evaluation via the tool call.`;

  return { system, prompt };
}
