import { BASE_SYSTEM_PROMPT, candidateContextBlock } from './shared.js';

export const version = 'synthesis.v3';

export function buildPrompt(dossier, competencyKeys, { stageEvaluations }) {
  const system = `${BASE_SYSTEM_PROMPT}

You are producing the FINAL CANDIDATE SUMMARY — an internal decision-making document for the interviewer
running the "Chat with Jess" conversation. It will be read by a CEO/executive, so it must work as a fast,
scannable read, not a report to be studied top to bottom. Competencies this pipeline tracks:
${competencyKeys.join(', ')}.

Formatting rules (follow all of them):
1. executiveSummary must be self-contained: verdict + confidence + the single main reason, in 2-3 sentences,
   readable with nothing else expanded.
2. candidateSummaryBullets are short, single-idea bullets (4-6 of them) — never a paragraph, never restating
   the verdict from executiveSummary. Each one is a specific supporting fact.
3. Every bullet, every green/yellow/red flag, and every scorecard entry MUST be attributed to who actually
   said it (evaluatorName) and which part of the scorecard/notes it came from (context) — pull these directly
   from the "evaluatorName" and "fields[].title" values in the feedback JSON below. Never write a generic
   placeholder like "an evaluator" or "the interviewer". If a claim is genuinely not traceable to one specific
   piece of evidence, don't include it.
4. Eliminate redundancy: if something is already said in executiveSummary, do not repeat it near-verbatim in
   the bullets, scorecard reasoning, flags, or finalRecommendationReasoning — each section must add something
   new or more specific than what came before it.
5. The first time you mention a candidate-specific tool/project name (e.g. something they built and named,
   like "Grill me" or "Prometheus"), add a short parenthetical explaining what it is, since the reader won't
   have context for it.
6. openQuestions: only genuinely unresolved questions — do not manufacture questions to fill a quota.
7. finalRecommendationReasoning must add a new angle (a specific risk, trade-off, or what would resolve it),
   not restate executiveSummary.
8. employmentStabilityNotes: only include an entry if the material explicitly says something about job
   tenure/stability (current employer, notice period, dual employment, a described history of role changes).
   Leave it an empty array if nothing is explicitly said — never infer stability or job-hopping risk from
   role, seniority, or age.
9. Tone: when the recommendation is anything other than a clean "proceed", frame it constructively — as a
   development/support need (e.g. "would benefit from pairing with a senior engineer on X", "coachable gap in
   Y") rather than as a warning or a reason for alarm. This is genuine, specific, constructive framing, not
   euphemism — still name the real gap, just describe it as something addressable rather than a red flag on
   the candidate as a person.

Only state what the feedback below actually supports — never invent a quote, a name, or an outcome.`;

  const prompt = `${candidateContextBlock(dossier)}

Every prior stage evaluation generated so far, in chronological order (JSON — use this for the overall
narrative and evidenceTimeline):
${JSON.stringify(stageEvaluations.map(e => ({
  stage: e.stage_name || e.stage_key,
  stageKey: e.stage_key,
  generatedAt: e.created_at,
  output: e.output,
})), null, 2)}

Raw feedback/scorecard submissions, simplified to the real evaluator name and the real field/section title
per submission — use THIS for every attribution (evaluatorName / context), not the stage evaluations above:
${JSON.stringify(dossier.feedbackSimplified || [], null, 2)}

Produce the Final Candidate Summary via the tool call.`;

  return { system, prompt };
}
