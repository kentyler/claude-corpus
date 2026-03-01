const { embed, pgVector } = require('../lib/embeddings');
const { mockFetch, sampleSecrets } = require('./helpers/mocks');

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

describe('pgVector', () => {
  it('formats array as pgvector literal string', () => {
    expect(pgVector([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });

  it('handles single element', () => {
    expect(pgVector([42])).toBe('[42]');
  });

  it('handles empty array', () => {
    expect(pgVector([])).toBe('[]');
  });
});

describe('embed', () => {
  it('returns null when no API keys configured', async () => {
    const result = await embed('hello', {});
    expect(result).toBeNull();
  });

  it('returns null with null secrets', async () => {
    const result = await embed('hello', null);
    expect(result).toBeNull();
  });

  describe('OpenAI path', () => {
    it('calls OpenAI when openai key present and returns normalized vector', async () => {
      const vec1536 = new Array(1536).fill(0.1);
      const fetchMock = mockFetch({ data: [{ embedding: vec1536 }] });

      const result = await embed('hello', sampleSecrets);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/embeddings');
      expect(result).toHaveLength(1536);
    });

    it('uses custom embedding model from secrets', async () => {
      const vec1536 = new Array(1536).fill(0.5);
      const fetchMock = mockFetch({ data: [{ embedding: vec1536 }] });
      const secrets = {
        openai: { api_key: 'sk-test', embedding_model: 'text-embedding-3-large' }
      };

      await embed('hello', secrets);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe('text-embedding-3-large');
    });

    it('truncates vectors longer than 1536', async () => {
      const vec2000 = new Array(2000).fill(0.1);
      mockFetch({ data: [{ embedding: vec2000 }] });

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const result = await embed('hello', sampleSecrets);
      consoleSpy.mockRestore();

      expect(result).toHaveLength(1536);
    });

    it('returns null on API error', async () => {
      mockFetch({ error: { message: 'rate limited' } }, 429);

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const result = await embed('hello', sampleSecrets);
      consoleSpy.mockRestore();

      expect(result).toBeNull();
    });

    it('returns null when response has unexpected shape', async () => {
      mockFetch({ unexpected: true });

      const result = await embed('hello', sampleSecrets);
      expect(result).toBeNull();
    });
  });

  describe('Google fallback path', () => {
    const googleOnlySecrets = { gemini: { api_key: 'gemini-key' } };

    it('uses Google when only gemini key present', async () => {
      const vec768 = new Array(768).fill(0.2);
      const fetchMock = mockFetch({ embedding: { values: vec768 } });

      const result = await embed('hello', googleOnlySecrets);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('generativelanguage.googleapis.com');
      // Should be zero-padded to 1536
      expect(result).toHaveLength(1536);
      expect(result[0]).toBe(0.2);
      expect(result[768]).toBe(0); // padded
    });

    it('returns null on Google API error', async () => {
      mockFetch({ error: { message: 'forbidden' } }, 403);

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const result = await embed('hello', googleOnlySecrets);
      consoleSpy.mockRestore();

      expect(result).toBeNull();
    });
  });

  it('prefers OpenAI over Google when both keys present', async () => {
    const vec1536 = new Array(1536).fill(0.3);
    const fetchMock = mockFetch({ data: [{ embedding: vec1536 }] });

    await embed('hello', sampleSecrets);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
  });

  it('returns null when fetch throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const result = await embed('hello', sampleSecrets);
    consoleSpy.mockRestore();

    expect(result).toBeNull();
  });
});
