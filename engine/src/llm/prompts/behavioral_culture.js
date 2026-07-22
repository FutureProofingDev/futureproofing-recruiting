import { BASE_SYSTEM_PROMPT, candidateContextBlock } from './shared.js';

export const version = 'behavioral_culture.v3';

export function buildPrompt(dossier, competencyKeys, { feedbackItems, transcript }) {
  const system = `${BASE_SYSTEM_PROMPT}

You are evaluating the BEHAVIORAL / CULTURE-FIT interview stage specifically — this scorecard covers things
like fit for autonomy/ambiguity, learning speed, EQ, passion, self-awareness, and communication/collaboration
style, as distinct from technical ability. Competencies this pipeline tracks: ${competencyKeys.join(', ')}.
A recruiter may also paste in the raw interview transcript for this stage — when present, treat it as the
richest source of evidence and prefer it over the scorecard's shorthand phrasing, using the scorecard mainly
to confirm the evaluator's overall read.`;

  const prompt = `${candidateContextBlock(dossier)}

Behavioral / culture-fit scorecard submissions found for this candidate, simplified to the real evaluator
name and real field titles (JSON):
${JSON.stringify(feedbackItems || [], null, 2)}

Interview transcript for this stage, if pasted in by the recruiter (may be empty if not yet provided):
${transcript || '(none provided yet)'}

Produce the structured behavioral/culture-fit evaluation via the tool call.`;

  return { system, prompt };
}
