import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/**
 * zahori is model-agnostic: the intelligence layer never hard-codes a vendor.
 * A model is chosen from a "provider:model" spec (or the ZAHORI_MODEL env var),
 * so a user can point it at Anthropic, OpenAI, or a local Ollama with no code
 * change. Keys come from the environment, BYO-key.
 *
 * Examples:
 *   anthropic:claude-sonnet-5     (ANTHROPIC_API_KEY)
 *   openai:gpt-5.4                (OPENAI_API_KEY)
 *   ollama:llama3.1               (local, no key; OLLAMA_BASE_URL to override)
 *   compat:my-model               (OPENAI_COMPATIBLE_BASE_URL + _API_KEY)
 */

export interface ModelSpec {
  provider: 'anthropic' | 'openai' | 'ollama' | 'compat';
  model: string;
}

const DEFAULTS: Record<ModelSpec['provider'], string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.4',
  ollama: 'llama3.1',
  compat: 'default',
};

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

/** Parse a "provider:model" spec. Falls back to ZAHORI_MODEL, then a sane default. */
export function parseModelSpec(spec?: string): ModelSpec {
  const raw = spec ?? process.env.ZAHORI_MODEL ?? inferFromEnv();
  const [providerRaw, ...rest] = raw.split(':');
  const provider = providerRaw as ModelSpec['provider'];
  if (!['anthropic', 'openai', 'ollama', 'compat'].includes(provider)) {
    throw new ModelConfigError(
      `Unknown model provider "${providerRaw}". Use anthropic:, openai:, ollama: or compat: (e.g. "anthropic:claude-sonnet-5").`,
    );
  }
  const model = rest.join(':') || DEFAULTS[provider];
  return { provider, model };
}

/** If no spec is given, pick a provider from whichever key is present. */
function inferFromEnv(): string {
  if (process.env.ANTHROPIC_API_KEY) return `anthropic:${DEFAULTS.anthropic}`;
  if (process.env.OPENAI_API_KEY) return `openai:${DEFAULTS.openai}`;
  if (process.env.OLLAMA_BASE_URL) return `ollama:${DEFAULTS.ollama}`;
  // Nothing configured: default to local Ollama so BYO-nothing still has a path.
  return `ollama:${DEFAULTS.ollama}`;
}

/** Build an AI SDK language model from a spec, validating required keys. */
export function resolveModel(spec?: string): LanguageModel {
  const { provider, model } = parseModelSpec(spec);

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new ModelConfigError('ANTHROPIC_API_KEY is not set. Export it, or use a different model provider.');
    return createAnthropic({ apiKey })(model);
  }
  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ModelConfigError('OPENAI_API_KEY is not set. Export it, or use a different model provider.');
    return createOpenAI({ apiKey })(model);
  }
  if (provider === 'ollama') {
    const baseURL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
    return createOpenAICompatible({ name: 'ollama', baseURL, apiKey: 'ollama' }).chatModel(model);
  }
  // compat: any OpenAI-compatible endpoint.
  const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
  if (!baseURL) throw new ModelConfigError('OPENAI_COMPATIBLE_BASE_URL is not set for the compat: provider.');
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY ?? 'not-needed';
  return createOpenAICompatible({ name: 'compat', baseURL, apiKey }).chatModel(model);
}

/** A short human label for logs, without leaking the key. */
export function describeModel(spec?: string): string {
  const { provider, model } = parseModelSpec(spec);
  return `${provider}:${model}`;
}
