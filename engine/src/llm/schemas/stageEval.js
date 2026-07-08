import { evidenceItemSchema, scoreItemSchema, stringListSchema } from './common.js';

// One tool schema per evalType, matching the exact fields requested in the
// brief for that stage type. `competencyKeys` comes from the pipeline
// config, never hardcoded here.
export function buildStageEvalTool(evalType, competencyKeys) {
  const scores = { type: 'array', items: scoreItemSchema(competencyKeys) };
  const evidence = { type: 'array', items: evidenceItemSchema };

  const shapes = {
    recruiter_feedback: {
      description: 'Structured evaluation of a recruiter interview stage.',
      properties: {
        summary: { type: 'string' },
        strengths: stringListSchema,
        concerns: stringListSchema,
        evidence,
        greenFlags: stringListSchema,
        yellowFlags: stringListSchema,
        redFlags: stringListSchema,
        suggestedScores: scores,
      },
      required: ['summary', 'strengths', 'concerns', 'evidence', 'greenFlags', 'yellowFlags', 'redFlags', 'suggestedScores'],
    },
    hackereval: {
      description: 'Structured evaluation of a HackerEval / technical-assessment result.',
      properties: {
        technicalSummary: { type: 'string' },
        strongAreas: stringListSchema,
        weakAreas: stringListSchema,
        importantFindings: stringListSchema,
        evidence,
        updatedScores: scores,
      },
      required: ['technicalSummary', 'strongAreas', 'weakAreas', 'importantFindings', 'evidence', 'updatedScores'],
    },
    technical_interview: {
      description: 'Structured evaluation of a technical interview stage.',
      properties: {
        summary: { type: 'string' },
        behavioralSignals: stringListSchema,
        technicalSignals: stringListSchema,
        ownershipSignals: stringListSchema,
        evidence,
        updatedScores: scores,
      },
      required: ['summary', 'behavioralSignals', 'technicalSignals', 'ownershipSignals', 'evidence', 'updatedScores'],
    },
    // Fallback for any completed stage that doesn't map to a specific
    // evalType above (e.g. a culture/behavioral round not modeled yet).
    generic_interview: {
      description: 'Structured evaluation of an interview stage not otherwise modeled.',
      properties: {
        summary: { type: 'string' },
        strengths: stringListSchema,
        concerns: stringListSchema,
        evidence,
        greenFlags: stringListSchema,
        yellowFlags: stringListSchema,
        redFlags: stringListSchema,
        suggestedScores: scores,
      },
      required: ['summary', 'strengths', 'concerns', 'evidence', 'greenFlags', 'yellowFlags', 'redFlags', 'suggestedScores'],
    },
  };

  const shape = shapes[evalType] || shapes.generic_interview;
  return {
    name: `record_${evalType}_evaluation`,
    description: shape.description,
    input_schema: {
      type: 'object',
      properties: shape.properties,
      required: shape.required,
    },
  };
}
