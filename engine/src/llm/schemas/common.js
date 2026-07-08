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
