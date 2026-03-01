const express = require('express');
const request = require('supertest');
const { createMockPool, mockFetch, sampleSecrets, sampleRegistry } = require('../helpers/mocks');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Mock embeddings module
jest.mock('../../lib/embeddings', () => ({
  embed: jest.fn().mockResolvedValue(null),
  pgVector: jest.fn(arr => '[' + arr.join(',') + ']')
}));

// Mock llm-router module
jest.mock('../../lib/llm-router', () => ({
  loadRegistry: jest.fn().mockResolvedValue([]),
  callLLM: jest.fn().mockResolvedValue({ content: 'LLM response', model: 'test-model' }),
  selectModels: jest.fn().mockResolvedValue({
    selectedModels: [],
    sampling: 'similarity',
    samplingParams: {},
    reasoning: 'test'
  }),
  getApiKey: jest.fn().mockReturnValue('fake-key')
}));

const { embed, pgVector } = require('../../lib/embeddings');
const { loadRegistry, callLLM, selectModels, getApiKey } = require('../../lib/llm-router');
const notesRouteFactory = require('../../routes/notes');

let pool, app, tmpDir;

beforeEach(async () => {
  pool = createMockPool();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-test-'));
  // Write a config with the sample registry
  await fs.writeFile(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({ 'llm-registry': sampleRegistry })
  );

  app = express();
  app.use(express.json());
  app.use('/api/notes', notesRouteFactory(pool, sampleSecrets, tmpDir));

  // Reset all mock state (including mockResolvedValueOnce queues)
  jest.resetAllMocks();
  // Re-apply defaults after reset
  pool.query.mockResolvedValue({ rows: [] });
  embed.mockResolvedValue(null);
  loadRegistry.mockResolvedValue([]);
  callLLM.mockResolvedValue({ content: 'LLM response', model: 'test-model' });
  selectModels.mockResolvedValue({
    selectedModels: [],
    sampling: 'similarity',
    samplingParams: {},
    reasoning: 'test'
  });
  getApiKey.mockReturnValue('fake-key');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('GET /api/notes', () => {
  it('returns entries with default limit', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, content: 'entry 1' }, { id: 2, content: 'entry 2' }]
    });

    const res = await request(app).get('/api/notes');

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(pool.query.mock.calls[0][1]).toEqual([200]); // default limit
  });

  it('respects custom limit', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/notes?limit=5');

    expect(pool.query.mock.calls[0][1]).toEqual([5]);
  });

  it('caps limit at 1000', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/notes?limit=5000');

    expect(pool.query.mock.calls[0][1]).toEqual([1000]);
  });

  it('returns 500 on database error', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).get('/api/notes');

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Failed to fetch');
  });
});

describe('POST /api/notes/search', () => {
  it('returns 400 when query missing', async () => {
    const res = await request(app).post('/api/notes/search').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('query is required');
  });

  it('returns 400 when query is empty string', async () => {
    const res = await request(app).post('/api/notes/search').send({ query: '   ' });
    expect(res.status).toBe(400);
  });

  it('performs semantic search when embedding succeeds', async () => {
    const vec = new Array(1536).fill(0.1);
    embed.mockResolvedValueOnce(vec);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, entry_type: 'human', content: 'match', distance: 0.1 }]
    });

    const res = await request(app)
      .post('/api/notes/search')
      .send({ query: 'test query', limit: 5 });

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(embed).toHaveBeenCalledWith('test query', sampleSecrets);
  });

  it('falls back to text search when embedding returns null', async () => {
    embed.mockResolvedValueOnce(null);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, entry_type: 'human', content: 'text match' }]
    });

    const res = await request(app)
      .post('/api/notes/search')
      .send({ query: 'search term' });

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    // Should use ILIKE query
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('ILIKE');
  });

  it('includes responses when include_responses=true', async () => {
    embed.mockResolvedValueOnce(null);
    // First query: text search returns human entry
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, entry_type: 'human', content: 'entry' }]
    });
    // Second query: responses for human entries
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 2, entry_type: 'llm', content: 'response', parent_id: 1 }]
    });

    const res = await request(app)
      .post('/api/notes/search')
      .send({ query: 'test', include_responses: true });

    expect(res.status).toBe(200);
    expect(res.body.entries[0].responses).toHaveLength(1);
    expect(res.body.entries[0].responses[0].parent_id).toBe(1);
  });
});

describe('POST /api/notes/log', () => {
  it('creates a log entry and returns it', async () => {
    const entry = { id: 1, entry_type: 'human', content: 'session log' };
    pool.query.mockResolvedValueOnce({ rows: [entry] });

    const res = await request(app)
      .post('/api/notes/log')
      .send({ content: 'session log' });

    expect(res.status).toBe(200);
    expect(res.body.entry.id).toBe(1);
    expect(res.body.entry.content).toBe('session log');
  });

  it('passes metadata as JSON', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    await request(app)
      .post('/api/notes/log')
      .send({ content: 'log', metadata: { project: 'test' } });

    const [, params] = pool.query.mock.calls[0];
    expect(params[2]).toBe('{"project":"test"}');
  });

  it('returns 400 when content missing', async () => {
    const res = await request(app).post('/api/notes/log').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('content is required');
  });

  it('returns 400 when content is empty', async () => {
    const res = await request(app).post('/api/notes/log').send({ content: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/notes/:id', () => {
  it('returns entry with responses', async () => {
    const entry = { id: 1, entry_type: 'human', content: 'entry', sampling_strategy: 'similarity' };
    pool.query
      .mockResolvedValueOnce({ rows: [entry] }) // entry
      .mockResolvedValueOnce({ rows: [{ id: 2, entry_type: 'llm', parent_id: 1 }] }); // responses

    const res = await request(app).get('/api/notes/1');

    expect(res.status).toBe(200);
    expect(res.body.entry.id).toBe(1);
    expect(res.body.responses).toHaveLength(1);
  });

  it('returns 400 for invalid id', async () => {
    const res = await request(app).get('/api/notes/abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid id');
  });

  it('returns 404 when not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/notes/999');
    expect(res.status).toBe(404);
  });

  it('looks up sampling_strategy from retrieval log when missing', async () => {
    const entry = { id: 1, entry_type: 'human', content: 'entry', sampling_strategy: null };
    pool.query
      .mockResolvedValueOnce({ rows: [entry] }) // entry
      .mockResolvedValueOnce({ rows: [{ id: 2 }] }) // responses
      .mockResolvedValueOnce({ rows: [{ strategy: 'distance' }] }); // retrieval lookup

    const res = await request(app).get('/api/notes/1');

    expect(res.status).toBe(200);
    expect(res.body.entry.sampling_strategy).toBe('distance');
  });
});

describe('POST /api/notes', () => {
  it('returns 400 when content missing', async () => {
    const res = await request(app).post('/api/notes').send({});
    expect(res.status).toBe(400);
  });

  it('creates entry and returns it with empty responses when no models', async () => {
    const humanEntry = { id: 1, entry_type: 'human', content: 'test entry' };
    // Insert human entry
    pool.query.mockResolvedValueOnce({ rows: [humanEntry] });
    // Recency fallback query
    pool.query.mockResolvedValueOnce({ rows: [] });
    // logRetrieval — no entries so it returns early

    const res = await request(app)
      .post('/api/notes')
      .send({ content: 'test entry' });

    expect(res.status).toBe(200);
    expect(res.body.entry.id).toBe(1);
    expect(res.body.responses).toEqual([]);
  });

  it('calls selected LLMs when registry has models', async () => {
    const humanEntry = { id: 1, entry_type: 'human', content: 'entry' };
    const llmEntry = { id: 2, entry_type: 'llm', content: 'LLM response', parent_id: 1 };

    loadRegistry.mockResolvedValueOnce(sampleRegistry);
    selectModels.mockResolvedValueOnce({
      selectedModels: [sampleRegistry[0]],
      sampling: 'similarity',
      samplingParams: {},
      reasoning: 'single model chosen'
    });
    callLLM.mockResolvedValueOnce({ content: 'LLM response', model: 'claude-opus-4-6' });

    pool.query
      .mockResolvedValueOnce({ rows: [humanEntry] }) // insert human
      .mockResolvedValueOnce({ rows: [] }) // retrieval context (recency fallback)
      .mockResolvedValueOnce({ rows: [] }) // logRetrieval (no entries returned, so insert skipped)
      .mockResolvedValueOnce({ rows: [] }) // persist routing metadata
      .mockResolvedValueOnce({ rows: [llmEntry] }); // insert LLM response

    const res = await request(app)
      .post('/api/notes')
      .send({ content: 'entry' });

    expect(res.status).toBe(200);
    expect(callLLM).toHaveBeenCalled();
  });
});

describe('POST /api/notes/:id/regenerate', () => {
  it('returns 400 for invalid id', async () => {
    const res = await request(app)
      .post('/api/notes/abc/regenerate')
      .send({ model_name: 'Claude Opus' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when model_name missing', async () => {
    const res = await request(app)
      .post('/api/notes/1/regenerate')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('model_name is required');
  });

  it('returns 404 when human entry not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    loadRegistry.mockResolvedValueOnce(sampleRegistry);

    const res = await request(app)
      .post('/api/notes/999/regenerate')
      .send({ model_name: 'Claude Opus' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when model not in registry', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, entry_type: 'human', content: 'entry' }]
    });
    loadRegistry.mockResolvedValueOnce(sampleRegistry);

    const res = await request(app)
      .post('/api/notes/1/regenerate')
      .send({ model_name: 'Nonexistent Model' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found in registry');
  });

  it('regenerates response successfully', async () => {
    const humanEntry = { id: 1, entry_type: 'human', content: 'test entry' };
    const llmEntry = { id: 3, entry_type: 'llm', content: 'Regenerated', parent_id: 1 };

    pool.query
      .mockResolvedValueOnce({ rows: [humanEntry] }) // lookup human
      .mockResolvedValueOnce({ rows: [] }) // retrieval context (recency)
      .mockResolvedValueOnce({ rows: [llmEntry] }) // insert LLM response
      .mockResolvedValueOnce({}); // update sampling metadata

    loadRegistry.mockResolvedValueOnce(sampleRegistry);
    callLLM.mockResolvedValueOnce({ content: 'Regenerated', model: 'claude-opus-4-6' });

    const res = await request(app)
      .post('/api/notes/1/regenerate')
      .send({ model_name: 'Claude Opus', temperature: 0.5 });

    expect(res.status).toBe(200);
    expect(res.body.response.content).toBe('Regenerated');
  });
});

describe('POST /api/notes/:id/followup', () => {
  it('returns 400 for invalid id', async () => {
    const res = await request(app)
      .post('/api/notes/abc/followup')
      .send({ prompt: 'follow up' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when prompt missing', async () => {
    const res = await request(app)
      .post('/api/notes/1/followup')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('prompt is required');
  });

  it('returns 404 when entry not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/notes/1/followup')
      .send({ prompt: 'follow up' });
    expect(res.status).toBe(404);
  });

  it('appends followup and updates entry', async () => {
    const entry = { id: 1, entry_type: 'human', content: 'original', model_name: null };
    pool.query
      .mockResolvedValueOnce({ rows: [entry] }) // fetch entry
      .mockResolvedValueOnce({}); // update entry

    loadRegistry.mockResolvedValueOnce(sampleRegistry);
    callLLM.mockResolvedValueOnce({ content: 'followup response', model: 'test' });

    const res = await request(app)
      .post('/api/notes/1/followup')
      .send({ prompt: 'tell me more' });

    expect(res.status).toBe(200);
    expect(res.body.content).toContain('original');
    expect(res.body.content).toContain('tell me more');
    expect(res.body.content).toContain('followup response');
  });

  it('returns 400 when no models available', async () => {
    const entry = { id: 1, entry_type: 'human', content: 'text', model_name: null };
    pool.query.mockResolvedValueOnce({ rows: [entry] });
    loadRegistry.mockResolvedValueOnce([]);

    const res = await request(app)
      .post('/api/notes/1/followup')
      .send({ prompt: 'follow up' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No models available');
  });
});

describe('POST /api/notes/backfill-embeddings', () => {
  it('processes entries missing embeddings', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total: '5' }] }) // count
      .mockResolvedValueOnce({ rows: [{ id: 1, content: 'entry 1' }, { id: 2, content: 'entry 2' }] }); // null entries

    const vec = new Array(1536).fill(0.1);
    embed.mockResolvedValue(vec);
    // Update calls for each entry
    pool.query.mockResolvedValue({});

    const res = await request(app).post('/api/notes/backfill-embeddings');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.pending).toBe(2);
    expect(res.body.processed).toBe(2);
  });

  it('handles embed failures gracefully', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, content: 'entry' }] });

    embed.mockResolvedValueOnce(null);

    const res = await request(app).post('/api/notes/backfill-embeddings');

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(0);
  });

  it('returns 503 when embedding column missing', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockRejectedValueOnce(new Error('column "embedding" does not exist'));

    const res = await request(app).post('/api/notes/backfill-embeddings');

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('pgvector');
  });
});
