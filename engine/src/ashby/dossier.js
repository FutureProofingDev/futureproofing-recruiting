// Assembles every registered collector's output into one normalized
// CandidateDossier for an application, and hashes it so the poller/service
// can detect "has anything changed since the last generation".

import {
  getCandidateProfile,
  getResumeFileInfo,
  getFeedbackForApplication,
  getNotesForCandidate,
  getInterviewsForApplication,
  getNotetakerTranscripts,
  extractTechAssessmentNotes,
  noteText,
} from './collectors.js';
import { simplifyFeedback } from './feedbackFormat.js';
import { hashJson } from '../util/hash.js';

// Registry of data-source collectors. Adding a future source = adding one
// entry here; buildDossier() and everything downstream needs no changes.
const SOURCES = [
  {
    // The caller (poller / manual regenerate) already fetched this
    // application fresh via application.list, so no extra call is needed
    // here — this source exists so a future collector could refresh it.
    key: 'application',
    fetch: async (apiKey, app) => app,
  },
  {
    key: 'candidateProfile',
    fetch: async (apiKey, app) => getCandidateProfile(apiKey, app.candidate?.id),
  },
  {
    key: 'resume',
    fetch: async (apiKey, app, ctx) => getResumeFileInfo(apiKey, ctx.candidateProfile?.resumeFileHandle),
  },
  {
    key: 'feedback',
    fetch: async (apiKey, app) => getFeedbackForApplication(apiKey, app.id),
  },
  {
    key: 'notes',
    fetch: async (apiKey, app) => getNotesForCandidate(apiKey, app.candidate?.id),
  },
  {
    key: 'interviews',
    fetch: async (apiKey, app) => getInterviewsForApplication(apiKey, app.id),
  },
  {
    key: 'notetakerTranscripts',
    fetch: async (apiKey, app, ctx) => getNotetakerTranscripts(apiKey, ctx.interviews || []),
  },
];

export async function buildDossier(apiKey, application) {
  const raw = {};
  // Sequential (not parallel): several collectors depend on an earlier
  // collector's output (resume needs candidateProfile, notetaker needs
  // interviews), and the per-candidate call volume here is small enough
  // that serial calls aren't a throughput concern.
  for (const source of SOURCES) {
    raw[source.key] = await source.fetch(apiKey, application, raw);
  }

  const linkedInUrl = raw.candidateProfile?.socialLinks?.find(
    l => /linkedin/i.test(l.type || l.url || '')
  )?.url || raw.candidateProfile?.linkedInUrl || null;

  const techAssessment = extractTechAssessmentNotes(raw.notes);
  const generalNotes = (raw.notes || [])
    .map(n => ({ text: noteText(n), date: n.createdAt || n.date || null }))
    .filter(n => n.text);

  const dossier = {
    applicationId: application.id,
    candidateId: application.candidate?.id || null,
    name: application.candidate?.name || null,
    email: application.candidate?.primaryEmailAddress?.value || null,
    jobTitle: application.job?.title || null,
    currentStage: application.currentInterviewStage?.title || application.applicationStage?.title || null,
    resume: raw.resume,
    linkedInUrl,
    feedback: raw.feedback,
    // Clean, attributable version of the same feedback (real evaluator name
    // + real field/section title) — used by the synthesis prompt so it can
    // cite who said what instead of summarizing anonymously.
    feedbackSimplified: (raw.feedback || []).map(simplifyFeedback),
    techAssessment,
    generalNotes,
    interviews: raw.interviews,
    notetakerTranscripts: raw.notetakerTranscripts,
    fetchedAt: new Date().toISOString(),
  };

  const contentHash = await hashJson({ ...dossier, fetchedAt: undefined });
  return { dossier, contentHash };
}
