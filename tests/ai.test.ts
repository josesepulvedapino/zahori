import { describe, expect, it } from 'vitest';
import { parseModelSpec, ModelConfigError } from '../src/ai/model.js';
import { profileIdFromUrl } from '../src/discover.js';

describe('parseModelSpec', () => {
  it('parses provider and model', () => {
    expect(parseModelSpec('anthropic:claude-sonnet-5')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(parseModelSpec('openai:gpt-5.4')).toEqual({ provider: 'openai', model: 'gpt-5.4' });
  });

  it('keeps colons inside the model name', () => {
    expect(parseModelSpec('compat:org/model:tag')).toEqual({ provider: 'compat', model: 'org/model:tag' });
  });

  it('fills a default model when only a provider is given', () => {
    expect(parseModelSpec('ollama').provider).toBe('ollama');
    expect(parseModelSpec('ollama').model).toBeTruthy();
  });

  it('rejects an unknown provider', () => {
    expect(() => parseModelSpec('bogus:x')).toThrow(ModelConfigError);
  });
});

describe('profileIdFromUrl', () => {
  it('derives a filesystem-safe id from the hostname', () => {
    expect(profileIdFromUrl('https://www.tv.example.org/watch/42')).toBe('tv-example-org');
    expect(profileIdFromUrl('https://VIDEO.city.gov:8443/live')).toBe('video-city-gov');
  });

  it('falls back to "site" for an unparseable URL', () => {
    expect(profileIdFromUrl('not a url')).toBe('not-a-url');
    expect(profileIdFromUrl('')).toBe('site');
  });
});
