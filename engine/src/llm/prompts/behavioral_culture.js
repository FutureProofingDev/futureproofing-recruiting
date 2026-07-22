import { BASE_SYSTEM_PROMPT, candidateContextBlock } from './shared.js';

export const version = 'behavioral_culture.v1';

export function buildPrompt(dossier, competencyKeys, { feedbackItems }) {
  const system = `${BASE_SYSTEM_PROMPT}

You are evaluating the BEHAVIORAL / CULTURE-FIT interview stage specifically — this scorecard covers things
like fit for autonomy/ambiguity, learning speed, EQ, passion, self-awareness, and communication/collaboration
style, as distinct from technical ability. Competencies this pipeline tracks: ${competencyKeys.join(', ')}.`;

  const prompt = `${candidateContextBlock(dossier)}

Behavioral / culture-fit scorecard submissions found for this candidate, simplified to the real evaluator
name and real field titles (JSON):
${JSON.stringify(feedbackItems || [], null, 2)}

Produce the structured behavioral/culture-fit evaluation via the tool call.`;

  return { system, prompt };
}
