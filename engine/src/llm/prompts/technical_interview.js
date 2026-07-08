import { BASE_SYSTEM_PROMPT, candidateContextBlock } from './shared.js';

export const version = 'technical_interview.v1';

export function buildPrompt(dossier, competencyKeys, { feedbackItems, transcripts }) {
  const system = `${BASE_SYSTEM_PROMPT}

You are evaluating the TECHNICAL INTERVIEW stage specifically, looking for behavioral, technical, and
ownership signals. Competencies this pipeline tracks: ${competencyKeys.join(', ')}.`;

  const prompt = `${candidateContextBlock(dossier)}

Technical interview scorecard/feedback submissions (raw Ashby data, JSON):
${JSON.stringify(feedbackItems, null, 2)}

Interview transcript(s) for this stage, if available (JSON, may be empty if not recorded/transcribed):
${JSON.stringify(transcripts, null, 2)}

Produce the structured technical-interview evaluation via the tool call.`;

  return { system, prompt };
}
