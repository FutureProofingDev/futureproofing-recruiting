import { scoreItemSchema, stringListSchema } from './common.js';

// Final Candidate Summary — internal decision-making document, not
// client-facing. Mirrors every section requested in the brief.
export function buildSynthesisTool(competencyKeys) {
  return {
    name: 'record_final_candidate_summary',
    description: 'The internal Final Candidate Summary synthesized from every prior stage evaluation, for the next interviewer to read before "Chat with Jess".',
    input_schema: {
      type: 'object',
      properties: {
        candidateSummary: { type: 'string', description: 'What we already know about this candidate, in plain terms.' },
        overallRecommendation: { type: 'string' },
        confidenceLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
        scorecard: { type: 'array', items: scoreItemSchema(competencyKeys), description: 'One entry per competency.' },
        greenFlags: stringListSchema,
        yellowFlags: stringListSchema,
        redFlags: stringListSchema,
        evidenceTimeline: {
          type: 'array',
          description: 'How the candidate evolved, one entry per completed stage in chronological order.',
          items: {
            type: 'object',
            properties: {
              stage: { type: 'string' },
              keyFindings: { type: 'string' },
              whatChanged: { type: 'string', description: 'What this stage confirmed, contradicted, or added versus prior stages.' },
            },
            required: ['stage', 'keyFindings', 'whatChanged'],
          },
        },
        currentStatus: { type: 'string', description: 'One-line summary of where things stand right now, going into "Chat with Jess".' },
        openQuestions: {
          type: 'array',
          description: 'Only unresolved questions Jess still needs to answer during the interview.',
          items: { type: 'string' },
        },
        finalRecommendation: { type: 'string', enum: ['proceed', 'proceed_with_caution', 'reject'] },
        finalRecommendationReasoning: { type: 'string' },
      },
      required: [
        'candidateSummary', 'overallRecommendation', 'confidenceLevel', 'scorecard',
        'greenFlags', 'yellowFlags', 'redFlags', 'evidenceTimeline', 'currentStatus',
        'openQuestions', 'finalRecommendation', 'finalRecommendationReasoning',
      ],
    },
  };
}
