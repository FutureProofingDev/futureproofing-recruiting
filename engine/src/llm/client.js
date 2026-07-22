// Fetch-based Anthropic client — same shape as the existing Claude
// integration in gabi-wellness-bot-cf (no SDK dependency). Uses forced
// tool-use so every call returns schema-validated JSON, never parsed prose,
// which is what makes recruiter-facing reports consistent across runs.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Seen live: some candidates' evidence is long enough that a detailed,
// fully-cited structured answer runs past 4096 output tokens, truncating
// the tool call mid-JSON (which then fails validation below in confusing,
// inconsistent ways — sometimes as a wrong-typed field, sometimes as a
// missing one, depending on exactly where the cutoff landed). Doubled as
// the fix, plus stop_reason is checked explicitly so a real future
// truncation is diagnosed clearly instead of guessed at again.
const DEFAULT_MAX_TOKENS = 8192;

// Note: this model rejects an explicit `temperature` override ("temperature
// is deprecated for this model") — discovered live in production. Determinism
// here comes from forced tool-use + low-ambiguity prompts, not sampling
// temperature.
export async function generateStructured(env, { system, prompt, tool, model, retries = 3 }) {
  const body = {
    model: model || env.ANTHROPIC_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: prompt }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, Math.min(Math.pow(2, attempt - 1) * 1500, 12000)));
    }

    let res;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      if (attempt === retries - 1) throw networkErr;
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt < retries - 1) continue;
      throw new Error(`Anthropic API error ${res.status} after retries`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    const data = await res.json();

    if (data.stop_reason === 'max_tokens') {
      if (attempt === retries - 1) throw new Error(`Anthropic response was truncated at max_tokens (${DEFAULT_MAX_TOKENS}) — the tool call never finished`);
      continue;
    }

    const toolUse = (data.content || []).find(b => b.type === 'tool_use');
    if (!toolUse) {
      if (attempt === retries - 1) throw new Error('Anthropic response did not include the expected tool_use block');
      continue;
    }

    // Anthropic tool-use is not hard-validated against the schema server-side —
    // the model can still omit a `required` field, or get a field's basic
    // type wrong. Seen live, repeatedly, across multiple evalTypes: instead
    // of a clean JSON array, an array-typed field comes back as a STRING
    // containing leaked tool-call XML syntax the model uses internally
    // (e.g. `"strongAreas": "\n<parameter name=\"strongAreas\">[\"a\",\"b\"]"`,
    // or `<item>...</item>` bullets). This isn't a one-off flake — it recurred
    // on 6/6 consecutive attempts in production regardless of prompt wording
    // or output-length bounding, so instead of just retrying (which reliably
    // reproduces the same failure), repair() first tries to recover the real
    // data from the leaked-XML string before falling back to a retry.
    const repaired = repairArrayFields(tool.input_schema, toolUse.input);

    const missing = missingRequiredFields(tool.input_schema, repaired);
    if (missing.length) {
      console.error(`[generateStructured:${tool.name}] missing fields ${missing.join(', ')} — raw input: ${JSON.stringify(toolUse.input).slice(0, 4000)}`);
      if (attempt === retries - 1) throw new Error(`Anthropic tool_use response missing required field(s): ${missing.join(', ')}`);
      continue;
    }

    const wrongType = arrayTypeErrors(tool.input_schema, repaired);
    if (wrongType.length) {
      console.error(`[generateStructured:${tool.name}] non-array fields ${wrongType.join(', ')} — raw input: ${JSON.stringify(toolUse.input).slice(0, 4000)}`);
      if (attempt === retries - 1) throw new Error(`Anthropic tool_use response has non-array value for field(s) declared as arrays: ${wrongType.join(', ')}`);
      continue;
    }

    return repaired;
  }
}

function missingRequiredFields(schema, input) {
  const required = (schema && schema.required) || [];
  return required.filter(key => input == null || input[key] === undefined);
}

function arrayTypeErrors(schema, input) {
  const props = (schema && schema.properties) || {};
  return Object.entries(props)
    .filter(([key, propSchema]) => propSchema.type === 'array' && input?.[key] !== undefined && !Array.isArray(input[key]))
    .map(([key]) => key);
}

// Best-effort recovery for array-typed fields that came back as a string
// instead of a real array. Returns a shallow copy of `input` with whatever
// fields could be salvaged replaced by real arrays; fields that can't be
// salvaged are left as-is so arrayTypeErrors() still catches them.
function repairArrayFields(schema, input) {
  const props = (schema && schema.properties) || {};
  const result = { ...input };
  for (const [key, propSchema] of Object.entries(props)) {
    if (propSchema.type !== 'array') continue;
    const value = result[key];
    if (Array.isArray(value) || typeof value !== 'string') continue;
    const recovered = coerceStringToArray(value, propSchema.items);
    if (recovered) result[key] = recovered;
  }
  return result;
}

function coerceStringToArray(raw, itemSchema) {
  // The model's leaked syntax looks like `<parameter name="x">...</parameter>`
  // or a bare opening tag — strip it, keeping whatever real content follows.
  const s = raw.replace(/<\/?parameter[^>]*>/gi, '\n').trim();

  // Prefer a well-formed JSON array/object embedded in what's left.
  const bracket = s.match(/\[[\s\S]*\]/);
  if (bracket) {
    try {
      const parsed = JSON.parse(bracket[0]);
      if (Array.isArray(parsed)) return coerceItemShapes(parsed, itemSchema);
    } catch { /* fall through */ }
  }
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return coerceItemShapes(parsed, itemSchema);
  } catch { /* fall through */ }

  // Custom `<item>...</item>` bullets — only meaningful for plain-string lists.
  if (!itemSchema || itemSchema.type !== 'object') {
    const items = [...s.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1].trim()).filter(Boolean);
    if (items.length) return items;
    return s ? [s] : [];
  }

  // Object-shaped items (evidence, scores) with nothing recoverable —
  // better to return an empty list than fabricate a wrong-shaped object.
  return [];
}

function coerceItemShapes(items, itemSchema) {
  if (!itemSchema || itemSchema.type !== 'object') {
    return items.map(x => (typeof x === 'string' ? x : JSON.stringify(x)));
  }
  const required = itemSchema.required || [];
  return items.filter(item => item && typeof item === 'object' && required.every(k => item[k] !== undefined));
}
