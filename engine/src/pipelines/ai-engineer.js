// The ONLY file that names "AI Engineer". A future pipeline (Data Scientist,
// Engagement Manager, ...) is added by writing one file shaped like this one
// and registering it in ./index.js — the engine core (poller, evaluation
// service) never special-cases a job title or a competency name.

export const aiEngineerPipeline = {
  key: 'ai-engineer',
  label: 'AI Engineer',

  // Matches the job.list title, same heuristic already used in
  // ../../functions/api/report.js and talent.js.
  matchesJob(jobTitle) {
    const t = (jobTitle || '').toLowerCase();
    return t.includes('ai engineer') || (t.includes('ai') && t.includes('software engineer'));
  },

  // The stage whose arrival kicks off the whole evaluation run.
  triggerStage: {
    label: 'Chat with Jess',
    match(stageName) {
      return /chat with jess/i.test(stageName || '');
    },
  },

  // Ordered stage definitions. Each maps a piece of evidence (a scorecard/
  // feedback title, or a special non-feedback source like free-text notes)
  // to an evalType, which selects the prompt + schema used to evaluate it.
  stages: [
    {
      key: 'recruiter_interview',
      label: 'Recruiter Interview',
      evalType: 'recruiter_feedback',
      sourceType: 'feedback',
      match: title => /recruiter/i.test(title || ''),
    },
    {
      key: 'hackereval',
      label: 'HackerEval',
      evalType: 'hackereval',
      sourceType: 'techAssessment', // pulled from dossier.techAssessment (free-text notes), not scorecards
    },
    {
      key: 'technical_interview',
      label: 'Technical Interview',
      evalType: 'technical_interview',
      sourceType: 'feedback',
      match: title => /technical interview|tech interview/i.test(title || ''),
    },
  ],

  // Fallback evalType for any completed-stage feedback that doesn't match
  // one of the stage definitions above (e.g. a culture/behavioral round).
  fallbackEvalType: 'generic_interview',

  // Scorecard dimensions for the Final Candidate Summary. Score 1-5, each
  // with a confidence and reasoning (see llm/schemas/synthesis.js).
  competencies: [
    { key: 'kodawari', label: 'Kodawari' },
    { key: 'communication', label: 'Communication' },
    { key: 'engineering', label: 'Engineering' },
    { key: 'agentic_coding', label: 'Agentic Coding' },
    { key: 'coachability', label: 'Coachability' },
  ],
};
