import { BASE_SYSTEM_PROMPT, candidateContextBlock } from './shared.js';

export const version = 'recruiter_feedback.v2';

export function buildPrompt(dossier, competencyKeys, { feedbackItems }) {
  const system = `${BASE_SYSTEM_PROMPT}

You are evaluating the RECRUITER INTERVIEW stage specifically. Competencies this pipeline tracks: ${competencyKeys.join(', ')}.`;

  const prompt = `${candidateContextBlock(dossier)}

Recruiter interview scorecard/feedback submissions for this stage (raw Ashby data, JSON):
${JSON.stringify(feedbackItems, null, 2)}

Produce the structured recruiter-interview evaluation via the tool call.`;

  return { system, prompt };
}
