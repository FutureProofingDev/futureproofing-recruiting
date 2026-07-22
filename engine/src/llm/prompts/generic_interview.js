import { BASE_SYSTEM_PROMPT, candidateContextBlock } from './shared.js';

export const version = 'generic_interview.v2';

// Fallback for any completed stage whose scorecard doesn't map to a
// specifically-modeled evalType (e.g. a culture/behavioral round).
export function buildPrompt(dossier, competencyKeys, { stageName, feedbackItems }) {
  const system = `${BASE_SYSTEM_PROMPT}

You are evaluating the "${stageName || 'interview'}" stage. Competencies this pipeline tracks: ${competencyKeys.join(', ')}.`;

  const prompt = `${candidateContextBlock(dossier)}

Scorecard/feedback submissions for this stage (raw Ashby data, JSON):
${JSON.stringify(feedbackItems, null, 2)}

Produce the structured evaluation via the tool call.`;

  return { system, prompt };
}
