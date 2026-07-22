// Fetch-based Anthropic client — same shape as the existing Claude
// integration in gabi-wellness-bot-cf (no SDK dependency). Uses forced
// tool-use so every call returns schema-validated JSON, never parsed prose,
// which is what makes recruiter-facing reports consistent across runs.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const DEFAULT_MAX_TOKENS = 4096;

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
    const toolUse = (data.content || []).find(b => b.type === 'tool_use');
    if (!toolUse) {
      if (attempt === retries - 1) throw new Error('Anthropic response did not include the expected tool_use block');
      continue;
    }

    // Anthropic tool-use is not hard-validated against the schema server-side —
    // the model can still omit a `required` field, or (seen live: an
    // "updatedScores" array field came back as an XML-tag-formatted string
    // instead of a JSON array) get a field's basic type wrong. Treat both as
    // retryable failures rather than silently shipping broken data the UI
    // will crash trying to render.
    const missing = missingRequiredFields(tool.input_schema, toolUse.input);
    if (missing.length) {
      if (attempt === retries - 1) throw new Error(`Anthropic tool_use response missing required field(s): ${missing.join(', ')}`);
      continue;
    }

    const wrongType = arrayTypeErrors(tool.input_schema, toolUse.input);
    if (wrongType.length) {
      if (attempt === retries - 1) throw new Error(`Anthropic tool_use response has non-array value for field(s) declared as arrays: ${wrongType.join(', ')}`);
      continue;
    }

    return toolUse.input;
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
