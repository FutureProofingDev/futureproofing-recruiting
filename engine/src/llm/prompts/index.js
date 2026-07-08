import * as recruiterFeedback from './recruiter_feedback.js';
import * as hackereval from './hackereval.js';
import * as technicalInterview from './technical_interview.js';
import * as genericInterview from './generic_interview.js';
import * as synthesis from './synthesis.js';

// evalType -> { version, buildPrompt(dossier, competencyKeys, evidence) }
export const STAGE_PROMPTS = {
  recruiter_feedback: recruiterFeedback,
  hackereval: hackereval,
  technical_interview: technicalInterview,
  generic_interview: genericInterview,
};

export const SYNTHESIS_PROMPT = synthesis;

export function getStagePrompt(evalType) {
  return STAGE_PROMPTS[evalType] || STAGE_PROMPTS.generic_interview;
}
