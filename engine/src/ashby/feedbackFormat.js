// Turns a raw Ashby feedback/scorecard submission into a compact,
// human-readable shape the LLM can cite directly: the real evaluator name
// (from submittedByUser) and the real field/section title (e.g. "Potential
// Concerns", "Candidate's Strengths") — instead of the noisy raw payload
// (form schema, option-value UUIDs) that dossier.feedback carries for the
// per-stage evaluation prompts.

function buildFieldDefs(fb) {
  const map = new Map();
  const fd = fb.formDefinition || {};
  const sections = Array.isArray(fd.sections) ? fd.sections
                 : Array.isArray(fd.fields) ? [{ fields: fd.fields }] : [];
  for (const sec of sections) {
    for (const item of (sec.fields || [])) {
      const f = item.field || item;
      if (f && f.path) map.set(f.path, f);
    }
  }
  return map;
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function humanizeValue(rawVal, def) {
  if (rawVal == null || rawVal === '') return null;
  if (def && Array.isArray(def.selectableValues) && def.selectableValues.length) {
    const opt = def.selectableValues.find(o => o.value === rawVal || o.label === rawVal);
    if (opt) return opt.label || opt.value;
  }
  if (typeof rawVal === 'string') return stripHtml(rawVal) || null;
  if (typeof rawVal === 'object') {
    if (rawVal.label) return rawVal.label;
    if (Array.isArray(rawVal.selectedOptions)) return rawVal.selectedOptions.map(o => o.label).filter(Boolean).join(', ') || null;
  }
  return String(rawVal);
}

export function simplifyFeedback(fb) {
  const defs = buildFieldDefs(fb);
  const submitted = (fb.submittedValues && typeof fb.submittedValues === 'object' && !Array.isArray(fb.submittedValues))
    ? fb.submittedValues : {};

  const fields = [];
  for (const [path, rawVal] of Object.entries(submitted)) {
    const def = defs.get(path);
    const value = humanizeValue(rawVal, def);
    if (!value) continue;
    const title = String((def && (def.title || def.humanReadablePath)) || path).trim();
    fields.push({ title, value });
  }

  const u = fb.submittedByUser || {};
  const evaluatorName = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Unknown evaluator';

  return { evaluatorName, submittedAt: fb.submittedAt || null, fields };
}
