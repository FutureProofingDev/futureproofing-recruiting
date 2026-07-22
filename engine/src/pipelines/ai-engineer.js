// The ONLY file that names "AI Engineer". A future pipeline (Data Scientist,
// Engagement Manager, ...) is added by writing one file shaped like this one
// and registering it in ./index.js — the engine core (poller, evaluation
// service) never special-cases a job title or a competency name.

export const aiEngineerPipeline = {
  key: 'ai-engineer',
  label: 'AI Engineer',

  // Matches the job.list title. Covers both the "AI Engineer" and "Applied
  // AI/ML Engineer" job postings — same interview process, scorecard, and
  // competencies for both, just a different official title in Ashby.
  matchesJob(jobTitle) {
    const t = (jobTitle || '').toLowerCase();
    return t.includes('ai engineer') ||
           t.includes('ai/ml engineer') ||
           t.includes('ai / ml engineer') ||
           (t.includes('ai') && t.includes('software engineer'));
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
      sourceType: 'techAssessment', // pulled from dossier.techAssessment (free-text notes) primarily
      // Some candidates' HackerEval-equivalent lives in a scorecard
      // submission instead of a free-text note (e.g. Rafael Rovira's bare
      // "Score" form, or Gabe Murillo's technical-assessment form) —
      // Ashby doesn't expose a usable stage title in this org, so this
      // matches by field composition instead.
      matchFeedbackFields(fieldTitles) {
        return fieldTitles.has('Score') || fieldTitles.has('Technical Depth & System Understanding');
      },
    },
    {
      key: 'technical_interview',
      label: 'Technical Interview',
      evalType: 'technical_interview',
      sourceType: 'feedback',
      match: title => /technical interview|tech interview/i.test(title || ''),
    },
    {
      key: 'behavioral_culture',
      label: 'Behavioral & Culture Interview',
      evalType: 'behavioral_culture',
      sourceType: 'feedback-matched',
      // The recruiter pastes the interview transcript by hand (no Ashby
      // Notetaker / Drive integration for it) — see manual_notes table,
      // noteType 'interview_transcript'. Folding it into this stage's
      // evidence is what makes saving a new transcript change the input
      // hash and trigger a re-evaluation.
      includeManualTranscript: true,
      // Gabe Murillo's behavioral/culture-fit scorecard — matched by field
      // composition since Ashby doesn't expose a usable stage title here.
      // Some job families' Ashby form doesn't carry these specific
      // statements (e.g. "Applied AI/ML Engineer" reqs use a bare
      // Overall Recommendation + free-text Feedback form) — Gabe always
      // runs the behavioral/culture-fit interview regardless of which
      // form Ashby happens to attach to the req, so his submissions count
      // here even when the field set is generic.
      matchFeedbackFields(fieldTitles, fb) {
        return fieldTitles.has('The candidate is a structured communicator.') ||
               fieldTitles.has('The candidate demonstrates high EQ, passion, and self-awareness') ||
               fb?.evaluatorName === 'Gabe Murillo';
      },
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
