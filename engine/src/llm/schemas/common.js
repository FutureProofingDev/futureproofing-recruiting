// Shared JSON-schema building blocks. Schemas are built per-call (not
// static) so the "competency" enum always matches the calling pipeline's
// configured competencies — this is what keeps the schema layer pipeline-
// agnostic instead of hardcoding "Kodawari" etc. here.

export const evidenceItemSchema = {
  type: 'object',
  properties: {
    quote: { type: 'string', description: 'A short, verbatim or near-verbatim quote/note backing a claim above.' },
    source: { type: 'string', description: 'Where this came from, e.g. "Recruiter scorecard" or "Candidate note, 2026-03-01".' },
  },
  required: ['quote', 'source'],
};

export function scoreItemSchema(competencyKeys) {
  return {
    type: 'object',
    properties: {
      competency: { type: 'string', enum: competencyKeys },
      score: { type: 'integer', minimum: 1, maximum: 5 },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      reasoning: { type: 'string' },
    },
    required: ['competency', 'score', 'confidence', 'reasoning'],
  };
}

export const stringListSchema = { type: 'array', items: { type: 'string' } };

// Bounded variant — seen live: an unbounded list + evidence array combo
// pushed a response long enough to run past the token cap and truncate
// mid-JSON. Capping list length keeps output length predictable.
export function boundedStringListSchema(maxItems = 5) {
  return { type: 'array', maxItems, items: { type: 'string' } };
}

export function boundedEvidenceSchema(maxItems = 4) {
  return { type: 'array', maxItems, items: evidenceItemSchema };
}

// Attribution-required variants, used by the synthesis step only (it has
// access to the real evaluator names + form field titles via
// dossier.feedbackSimplified — see llm/prompts/synthesis.js). Kept separate
// from evidenceItemSchema/scoreItemSchema above so the per-stage evaluation
// prompts/schemas are unaffected.
export const attributedTextSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'One short, single idea.' },
    evaluatorName: { type: 'string', description: 'The real name of who said this (e.g. "Rafael Rovira"), taken from the evidence. Never a generic placeholder like "an evaluator" or "the interviewer".' },
    context: { type: 'string', description: 'The exact form field/section this came from, e.g. "Potential Concerns", "Candidate\'s Strengths", "Notes".' },
  },
  required: ['text', 'evaluatorName', 'context'],
};

export function attributedScoreItemSchema(competencyKeys) {
  return {
    type: 'object',
    properties: {
      competency: { type: 'string', enum: competencyKeys },
      score: { type: 'integer', minimum: 1, maximum: 5 },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      reasoning: { type: 'string' },
      evaluatorName: { type: 'string', description: 'Who provided the strongest evidence for this score, e.g. "Rafael Rovira", or "Rafael Rovira & Gabe Murillo" if genuinely aggregated across multiple. Never generic.' },
      context: { type: 'string', description: 'The section/field this evidence came from, e.g. "Potential Concerns".' },
    },
    required: ['competency', 'score', 'confidence', 'reasoning', 'evaluatorName', 'context'],
  };
}
