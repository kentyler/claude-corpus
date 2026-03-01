const { loadRegistry, callLLM, selectModels, getApiKey } = require('../lib/llm-router');
const { mockFetch, sampleSecrets, sampleRegistry } = require('./helpers/mocks');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

describe('getApiKey', () => {
  it('returns anthropic key', () => {
    expect(getApiKey('anthropic', sampleSecrets)).toBe('sk-ant-test-key');
  });

  it('returns openai key', () => {
    expect(getApiKey('openai', sampleSecrets)).toBe('sk-openai-test-key');
  });

  it('maps google provider to gemini key', () => {
    expect(getApiKey('google', sampleSecrets)).toBe('gemini-test-key');
  });

  it('returns undefined for missing provider', () => {
    expect(getApiKey('unknown', sampleSecrets)).toBeUndefined();
  });

  it('returns undefined when secrets is null', () => {
    expect(getApiKey('anthropic', null)).toBeUndefined();
  });
});

describe('loadRegistry', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-router-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads registry from config.json', async () => {
    const config = { 'llm-registry': sampleRegistry };
    await fs.writeFile(path.join(tmpDir, 'config.json'), JSON.stringify(config));

    const result = await loadRegistry(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('claude-opus');
  });

  it('returns empty array when file missing', async () => {
    const result = await loadRegistry(path.join(tmpDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('returns empty array on parse error', async () => {
    await fs.writeFile(path.join(tmpDir, 'config.json'), 'not json{{{');
    const result = await loadRegistry(tmpDir);
    expect(result).toEqual([]);
  });

  it('returns empty array when llm-registry key missing', async () => {
    await fs.writeFile(path.join(tmpDir, 'config.json'), '{"other": true}');
    const result = await loadRegistry(tmpDir);
    expect(result).toEqual([]);
  });
});

describe('callLLM', () => {
  it('throws when no API key provided', async () => {
    await expect(
      callLLM('anthropic', 'model', 'sys', [{ role: 'user', content: 'hi' }], {}, null)
    ).rejects.toThrow('No API key');
  });

  it('throws for unsupported provider', async () => {
    await expect(
      callLLM('azure', 'model', 'sys', [{ role: 'user', content: 'hi' }], {}, 'key')
    ).rejects.toThrow('Unsupported provider');
  });

  describe('Anthropic provider', () => {
    it('formats request correctly and parses response', async () => {
      const fetchMock = mockFetch({
        content: [{ type: 'text', text: 'Response text' }]
      });

      const result = await callLLM(
        'anthropic', 'claude-opus-4-6', 'system prompt',
        [{ role: 'user', content: 'hello' }],
        { max_tokens: 1024, temperature: 0.5 },
        'sk-key'
      );

      expect(result.content).toBe('Response text');
      expect(result.model).toBe('claude-opus-4-6');

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      const body = JSON.parse(opts.body);
      expect(body.model).toBe('claude-opus-4-6');
      expect(body.system).toBe('system prompt');
      expect(body.temperature).toBe(0.5);
      expect(opts.headers['x-api-key']).toBe('sk-key');
    });

    it('throws on non-ok response', async () => {
      mockFetch({ error: { message: 'Invalid key' } }, 401);

      await expect(
        callLLM('anthropic', 'model', 'sys', [{ role: 'user', content: 'hi' }], {}, 'bad-key')
      ).rejects.toThrow('Invalid key');
    });
  });

  describe('OpenAI provider', () => {
    it('formats request correctly and parses response', async () => {
      const fetchMock = mockFetch({
        choices: [{ message: { content: 'GPT response' } }]
      });

      const result = await callLLM(
        'openai', 'gpt-5.2', 'system prompt',
        [{ role: 'user', content: 'hello' }],
        { max_tokens: 2048 },
        'sk-openai'
      );

      expect(result.content).toBe('GPT response');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-5.2');
      expect(body.messages[0].role).toBe('system');
      expect(body.max_completion_tokens).toBe(2048);
    });

    it('includes temperature only when 1.0', async () => {
      mockFetch({ choices: [{ message: { content: 'ok' } }] });

      await callLLM(
        'openai', 'gpt-5.2', 'sys',
        [{ role: 'user', content: 'hi' }],
        { temperature: 1.0 },
        'key'
      );
      let body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(1.0);

      mockFetch({ choices: [{ message: { content: 'ok' } }] });
      await callLLM(
        'openai', 'gpt-5.2', 'sys',
        [{ role: 'user', content: 'hi' }],
        { temperature: 0.5 },
        'key'
      );
      body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.temperature).toBeUndefined();
    });

    it('throws on non-ok response', async () => {
      mockFetch({ error: { message: 'Rate limit' } }, 429);

      await expect(
        callLLM('openai', 'model', 'sys', [{ role: 'user', content: 'hi' }], {}, 'key')
      ).rejects.toThrow('Rate limit');
    });
  });

  describe('Google provider', () => {
    it('formats request correctly and parses response', async () => {
      const fetchMock = mockFetch({
        candidates: [{ content: { parts: [{ text: 'Gemini response' }] } }]
      });

      const result = await callLLM(
        'google', 'gemini-3.1-pro', 'system prompt',
        [{ role: 'user', content: 'hello' }],
        { max_tokens: 1024, temperature: 0.8 },
        'gem-key'
      );

      expect(result.content).toBe('Gemini response');
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('gemini-3.1-pro');
      expect(url).toContain('key=gem-key');
    });

    it('throws on non-ok response', async () => {
      mockFetch({ error: { message: 'Quota exceeded' } }, 429);

      await expect(
        callLLM('google', 'model', 'sys', [{ role: 'user', content: 'hi' }], {}, 'key')
      ).rejects.toThrow('Quota exceeded');
    });
  });

  it('returns empty string when response has no content', async () => {
    mockFetch({ content: [] });
    const result = await callLLM(
      'anthropic', 'model', 'sys', [{ role: 'user', content: 'hi' }], {}, 'key'
    );
    expect(result.content).toBe('');
  });
});

describe('selectModels', () => {
  it('returns early with empty reasoning when no enabled models', async () => {
    const disabled = sampleRegistry.map(m => ({ ...m, enabled: false }));
    const result = await selectModels('entry text', disabled, sampleSecrets);
    expect(result.selectedModels).toEqual([]);
    expect(result.sampling).toBe('similarity');
  });

  it('returns the single model when only one enabled', async () => {
    const single = [sampleRegistry[0]];
    const result = await selectModels('entry text', single, sampleSecrets);
    expect(result.selectedModels).toHaveLength(1);
    expect(result.selectedModels[0].id).toBe('claude-opus');
  });

  it('parses secretary JSON response to select models', async () => {
    mockFetch({
      content: [{ type: 'text', text: '```json\n{"models": ["gpt-5"], "sampling": "random", "sampling_params": {}, "reasoning": "test"}\n```' }]
    });

    const result = await selectModels('deep philosophical entry', sampleRegistry, sampleSecrets);
    expect(result.selectedModels).toHaveLength(1);
    expect(result.selectedModels[0].id).toBe('gpt-5');
    expect(result.sampling).toBe('random');
    expect(result.reasoning).toBe('test');
  });

  it('falls back to secretary on JSON parse failure', async () => {
    mockFetch({
      content: [{ type: 'text', text: 'I cannot decide in JSON format' }]
    });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const result = await selectModels('entry', sampleRegistry, sampleSecrets);
    consoleSpy.mockRestore();

    expect(result.selectedModels).toHaveLength(1);
    expect(result.selectedModels[0].is_secretary).toBe(true);
    expect(result.reasoning).toContain('fallback');
  });

  it('falls back to secretary on LLM call error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const result = await selectModels('entry', sampleRegistry, sampleSecrets);
    consoleSpy.mockRestore();

    expect(result.selectedModels).toHaveLength(1);
    expect(result.selectedModels[0].is_secretary).toBe(true);
  });

  it('falls back when secretary has no API key', async () => {
    const result = await selectModels('entry', sampleRegistry, {});
    expect(result.selectedModels).toHaveLength(1);
    expect(result.reasoning).toContain('no secretary API key');
  });
});
