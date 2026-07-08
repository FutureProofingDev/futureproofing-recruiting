import { BASE_SYSTEM_PROMPT, candidateContextBlock } from './shared.js';

export const version = 'synthesis.v1';

export function buildPrompt(dossier, competencyKeys, { stageEvaluations }) {
  const system = `${BASE_SYSTEM_PROMPT}

You are producing the FINAL CANDIDATE SUMMARY — an internal decision-making document for the interviewer
running the "Chat with Jess" conversation, synthesizing every prior stage evaluation below. This is NOT
client-facing. It should let the reader immediately understand what's already known, what concerns remain,
and what still needs to be validated in this next conversation. Competencies this pipeline tracks:
${competencyKeys.join(', ')}. Only include an "open question" if it is genuinely unresolved by the evidence
below — do not manufacture questions for the sake of having some.`;

  const prompt = `${candidateContextBlock(dossier)}

Every prior stage evaluation generated so far, in chronological order (JSON):
${JSON.stringify(stageEvaluations.map(e => ({
  stage: e.stage_name || e.stage_key,
  stageKey: e.stage_key,
  generatedAt: e.created_at,
  output: e.output,
})), null, 2)}

Produce the Final Candidate Summary via the tool call.`;

  return { system, prompt };
}
