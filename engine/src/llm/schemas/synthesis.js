import { attributedTextSchema, attributedScoreItemSchema } from './common.js';

// Final Candidate Summary — internal decision-making document, not
// client-facing. Structured for a fast top-to-bottom read (executive
// summary + open questions + final call always visible) with attributed,
// citable detail underneath (bullets/flags/scorecard each name who said it
// and in which part of the scorecard/notes).
export function buildSynthesisTool(competencyKeys) {
  return {
    name: 'record_final_candidate_summary',
    description: 'The internal Final Candidate Summary synthesized from every prior stage evaluation, for the next interviewer to read before "Chat with Jess".',
    input_schema: {
      type: 'object',
      properties: {
        executiveSummary: {
          type: 'string',
          description: '2-3 sentences, always shown without expanding anything: the verdict, the confidence level, and the single main reason. Must stand alone — a reader should not need any other section to understand the headline.',
        },
        candidateSummaryBullets: {
          type: 'array',
          minItems: 4,
          maxItems: 6,
          description: '4-6 short, single-idea supporting bullets. Do not restate the verdict from executiveSummary — add the specific facts that back it up.',
          items: attributedTextSchema,
        },
        confidenceLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
        scorecard: {
          type: 'array',
          description: 'One entry per competency.',
          items: attributedScoreItemSchema(competencyKeys),
        },
        greenFlags: { type: 'array', items: attributedTextSchema },
        yellowFlags: { type: 'array', items: attributedTextSchema },
        redFlags: { type: 'array', items: attributedTextSchema },
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
        openQuestions: {
          type: 'array',
          description: 'Only unresolved questions Jess still needs to answer during the interview.',
          items: { type: 'string' },
        },
        finalRecommendation: { type: 'string', enum: ['proceed', 'proceed_with_caution', 'reject'] },
        finalRecommendationReasoning: {
          type: 'string',
          description: 'Must add something not already said in executiveSummary or the bullets — e.g. the specific risk/trade-off driving the recommendation.',
        },
      },
      required: [
        'executiveSummary', 'candidateSummaryBullets', 'confidenceLevel', 'scorecard',
        'greenFlags', 'yellowFlags', 'redFlags', 'evidenceTimeline',
        'openQuestions', 'finalRecommendation', 'finalRecommendationReasoning',
      ],
    },
  };
}
