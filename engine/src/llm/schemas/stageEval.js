import { scoreItemSchema, boundedStringListSchema, boundedEvidenceSchema } from './common.js';

// One tool schema per evalType, matching the exact fields requested in the
// brief for that stage type. `competencyKeys` comes from the pipeline
// config, never hardcoded here.
//
// Every list is length-capped (boundedStringListSchema / boundedEvidenceSchema)
// — seen live: an unbounded set of lists + evidence citations on top of each
// other produced a response long enough to run past the token cap and
// truncate mid-JSON, which then failed validation in confusing, inconsistent
// ways depending on exactly where the cutoff landed. Capping keeps total
// output length predictable regardless of how much source material exists.
export function buildStageEvalTool(evalType, competencyKeys) {
  const scores = { type: 'array', maxItems: competencyKeys.length, items: scoreItemSchema(competencyKeys) };
  const evidence = boundedEvidenceSchema(4);
  const list = () => boundedStringListSchema(5);

  const shapes = {
    recruiter_feedback: {
      description: 'Structured evaluation of a recruiter interview stage.',
      properties: {
        summary: { type: 'string' },
        strengths: list(),
        concerns: list(),
        evidence,
        greenFlags: list(),
        yellowFlags: list(),
        redFlags: list(),
        suggestedScores: scores,
      },
      required: ['summary', 'strengths', 'concerns', 'evidence', 'greenFlags', 'yellowFlags', 'redFlags', 'suggestedScores'],
    },
    hackereval: {
      description: 'Structured evaluation of a HackerEval / technical-assessment result.',
      properties: {
        technicalSummary: { type: 'string' },
        strongAreas: list(),
        weakAreas: list(),
        importantFindings: list(),
        evidence,
        updatedScores: scores,
      },
      required: ['technicalSummary', 'strongAreas', 'weakAreas', 'importantFindings', 'evidence', 'updatedScores'],
    },
    technical_interview: {
      description: 'Structured evaluation of a technical interview stage.',
      properties: {
        summary: { type: 'string' },
        behavioralSignals: list(),
        technicalSignals: list(),
        ownershipSignals: list(),
        evidence,
        updatedScores: scores,
      },
      required: ['summary', 'behavioralSignals', 'technicalSignals', 'ownershipSignals', 'evidence', 'updatedScores'],
    },
    behavioral_culture: {
      description: 'Structured evaluation of a behavioral / culture-fit interview stage.',
      properties: {
        summary: { type: 'string' },
        behavioralSignals: list(),
        cultureFitSignals: list(),
        evidence,
        updatedScores: scores,
      },
      required: ['summary', 'behavioralSignals', 'cultureFitSignals', 'evidence', 'updatedScores'],
    },
    // Fallback for any completed stage that doesn't map to a specific
    // evalType above (e.g. a culture/behavioral round not modeled yet).
    generic_interview: {
      description: 'Structured evaluation of an interview stage not otherwise modeled.',
      properties: {
        summary: { type: 'string' },
        strengths: list(),
        concerns: list(),
        evidence,
        greenFlags: list(),
        yellowFlags: list(),
        redFlags: list(),
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
