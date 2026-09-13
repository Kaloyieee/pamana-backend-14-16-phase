'use strict';

/**
 * OpenAI explanation helper for Phases 14-16.
 *
 * The numeric transport predictions remain deterministic and testable.
 * OpenAI receives only the computed result and turns it into a short,
 * passenger/LGU-friendly explanation. If the API is unavailable, the main
 * endpoint still succeeds and returns ai_explanation: null.
 */

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

function extractOutputText(payload) {
  if (!payload || !Array.isArray(payload.output)) return null;

  const pieces = [];
  for (const item of payload.output) {
    if (!Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content.type === 'output_text' && content.text) pieces.push(content.text);
    }
  }

  return pieces.join('\n').trim() || null;
}

async function generateTransportExplanation(kind, result) {
  const apiKey = process.env.OPENAI_API_KEY;
  const enabled = String(process.env.OPENAI_EXPLANATIONS || 'true').toLowerCase() !== 'false';

  if (!enabled) return { text: null, status: 'disabled', model: null };
  if (!apiKey) return { text: null, status: 'not_configured', model: null };

  const model = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 8000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        instructions:
          'You are the PAMANA rural mobility assistant. Explain transport predictions conservatively. Do not invent facts, routes, vehicles, or certainty. Mention uncertainty when confidence is low. Keep the answer to 2-3 short sentences.',
        input: `Prediction type: ${kind}\nComputed result: ${JSON.stringify(result)}`,
        max_output_tokens: 180,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.warn(`OpenAI explanation failed (${response.status}): ${detail.slice(0, 300)}`);
      return { text: null, status: `http_${response.status}`, model };
    }

    const payload = await response.json();
    return {
      text: extractOutputText(payload),
      status: 'ok',
      model: payload.model || model,
    };
  } catch (error) {
    console.warn('OpenAI explanation unavailable:', error.message);
    return { text: null, status: 'unavailable', model };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { generateTransportExplanation, extractOutputText };
