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
    if (!toolUse) throw new Error('Anthropic response did not include the expected tool_use block');
    return toolUse.input;
  }
}
