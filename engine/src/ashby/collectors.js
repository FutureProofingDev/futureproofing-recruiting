// One function per Ashby data source. Adding a future source (e.g. a new
// assessment tool) means adding one collector here and registering it in
// dossier.js — nothing else in the engine changes.
//
// Each collector is defensive: an org that doesn't have a given feature/scope
// enabled (e.g. AI Notetaker) gets an empty result, not a thrown error.

import { ashbyPost, ashbyPostSafe, ashbyPaginate } from './client.js';

export async function listJobs(apiKey, { includeArchived = true } = {}) {
  return ashbyPaginate(apiKey, '/job.list', { includeArchived }, { maxPages: 5 });
}

export async function listApplicationsForJob(apiKey, jobId, extraFilter = {}) {
  return ashbyPaginate(apiKey, '/application.list', { jobId, ...extraFilter });
}

// Candidate profile — includes resumeFileHandle + socialLinks (LinkedIn).
export async function getCandidateProfile(apiKey, candidateId) {
  if (!candidateId) return null;
  const data = await ashbyPostSafe(apiKey, '/candidate.info', { id: candidateId }, null);
  return data?.results || null;
}

// Resume: candidate.info's resumeFileHandle is an object ({id, name, handle}),
// not a bare string — file.info wants just the handle string. Returns a
// downloadable URL (Ashby: valid ~30 days) so the viewer can link straight
// to it; full text extraction is a future step, not needed just to attach it.
export async function getResumeFileInfo(apiKey, resumeFileHandle) {
  if (!resumeFileHandle) return null;
  const handle = typeof resumeFileHandle === 'string' ? resumeFileHandle : resumeFileHandle.handle;
  if (!handle) return null;
  const data = await ashbyPostSafe(apiKey, '/file.info', { fileHandle: handle }, null);
  if (!data?.results) return null;
  return { name: resumeFileHandle.name || null, ...data.results };
}

export async function getFeedbackForApplication(apiKey, applicationId) {
  for (const endpoint of ['/applicationFeedback.list', '/feedback.list']) {
    const data = await ashbyPostSafe(apiKey, endpoint, { applicationId }, null);
    const results = Array.isArray(data?.results) ? data.results : Array.isArray(data?.feedback) ? data.feedback : [];
    if (results.length) return results;
  }
  return [];
}

export async function getNotesForCandidate(apiKey, candidateId) {
  if (!candidateId) return [];
  const data = await ashbyPostSafe(apiKey, '/candidate.listNotes', { candidateId, limit: 100 }, null);
  return Array.isArray(data?.results) ? data.results : Array.isArray(data?.notes) ? data.notes : [];
}

export async function getInterviewsForApplication(apiKey, applicationId) {
  const data = await ashbyPostSafe(apiKey, '/interview.list', { applicationId }, null);
  return Array.isArray(data?.results) ? data.results : [];
}

// Best-effort: AI Notetaker is a paid add-on and may not be enabled for this
// org, or a given interview may not have been recorded/transcribed.
export async function getNotetakerTranscripts(apiKey, interviews) {
  const out = [];
  for (const interview of interviews || []) {
    const data = await ashbyPostSafe(apiKey, '/notetakerTranscriptInfo', { interviewId: interview.id }, null);
    if (data?.results) out.push({ interviewId: interview.id, interviewTitle: interview.title || interview.interviewStage?.title, transcript: data.results });
  }
  return out;
}

// HackerEval / tech-assessment results aren't a structured Ashby concept —
// they live as free-text candidate notes (usually a link + a "completed at
// NN%" line). Shared regex-based extraction, lifted from the existing
// ../../functions/api/talent.js parser.
const TECH_ASSESS_RE = /hacker\s*rank|hacker\s*eval|tech(nical)?\s*(test|assessment)|coding\s*(test|challenge|assessment)|tech\s*test/i;

export function extractTechAssessmentNotes(notes) {
  const items = [];
  for (const n of notes || []) {
    const t = noteText(n);
    if (!t || !TECH_ASSESS_RE.test(t)) continue;
    const url = (t.match(/https?:\/\/[^\s)]+/) || [null])[0];
    const pctMatch = t.match(/(\d{1,3})\s*%/);
    const pct = pctMatch ? Math.min(100, parseInt(pctMatch[1], 10)) : null;
    items.push({ date: noteDate(n), text: t.slice(0, 2000), url, pct });
  }
  items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return items;
}

// Salary expectation isn't a structured Ashby field either — recruiters log
// it as a free-text candidate note. Same regex-extraction shape as
// extractTechAssessmentNotes, covering English/Spanish/Portuguese phrasing
// since candidates are LATAM/Brazil-based.
// "compensa" (not the full "compensation") so common typos like
// "compensantion" (seen live in an Ashby note) still match; "\d+\s?k\b"
// so shorthand figures like "$4k-5k" match, not just full digit amounts.
const SALARY_RE = /salary|compensa|expected\s*(pay|rate|comp)|pretens[aã]o\s*salarial|expectativa\s*salarial|remunera[cç][aã]o|pretensión\s*salarial|\busd\b|\br\$\s?\d|\$\s?\d{3,}|\$?\d+\s?k\b/i;

export function extractSalaryNotes(notes) {
  const items = [];
  for (const n of notes || []) {
    const t = noteText(n);
    if (!t || !SALARY_RE.test(t)) continue;
    items.push({ date: noteDate(n), text: t.slice(0, 2000) });
  }
  items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return items;
}

export function noteText(note) {
  const raw = note.content || note.note || note.body || note.text || note.value || (typeof note === 'string' ? note : '') || '';
  return String(raw).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

export function noteDate(note) {
  return note.createdAt || note.submittedAt || note.updatedAt || note.date || null;
}

// Which interview stage a feedback/scorecard submission belongs to. Lifted
// from the equivalent logic in ../../functions/api/talent.js.
export function feedbackStageTitle(fb, fallback) {
  return fb.interviewStage?.title || fb.interviewStage?.name ||
         fb.interview?.title || fb.interviewEvent?.title ||
         fb.stage?.title || fb.stage ||
         fb.submittedFormInstance?.formDefinition?.title ||
         fb.formDefinition?.title || fallback || 'Evaluation';
}

// Groups feedback items by their stage title, so the evaluation service can
// generate one evaluation per distinct stage instead of per submission.
export function groupFeedbackByStage(feedback) {
  const groups = new Map();
  for (const fb of feedback || []) {
    const title = feedbackStageTitle(fb);
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(fb);
  }
  return groups;
}
