/**
 * Shared test utilities — mock pool, fetch, secrets, and registry.
 */

/**
 * Create a mock pg Pool.
 * By default, pool.query resolves to { rows: [] }.
 * Override per-test with mockPool.query.mockResolvedValueOnce(...).
 */
function createMockPool() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] })
  };
}

/**
 * Install a mock global.fetch that returns configurable responses.
 * Call with a response body (object) and optional status.
 * Returns the jest mock for assertions.
 *
 * Usage:
 *   const fetchMock = mockFetch({ data: [{ embedding: [1,2,3] }] });
 *   // ... call code that uses fetch ...
 *   expect(fetchMock).toHaveBeenCalledWith(...);
 */
function mockFetch(body = {}, status = 200) {
  const fn = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
  });
  global.fetch = fn;
  return fn;
}

/** Fake secrets with all providers populated. */
const sampleSecrets = {
  database: { password: 'testpass' },
  anthropic: { api_key: 'sk-ant-test-key' },
  openai: { api_key: 'sk-openai-test-key' },
  gemini: { api_key: 'gemini-test-key' }
};

/** Minimal LLM registry with one secretary and one responder. */
const sampleRegistry = [
  {
    id: 'claude-opus',
    name: 'Claude Opus',
    provider: 'anthropic',
    model_id: 'claude-opus-4-6-20250514',
    enabled: true,
    is_secretary: true,
    description: 'Secretary + responder',
    config: { max_tokens: 4096, temperature: 1.0 }
  },
  {
    id: 'gpt-5',
    name: 'GPT-5.2',
    provider: 'openai',
    model_id: 'gpt-5.2',
    enabled: true,
    is_secretary: false,
    description: 'Responder',
    config: { max_tokens: 2048, temperature: 1.0 }
  }
];

module.exports = { createMockPool, mockFetch, sampleSecrets, sampleRegistry };
