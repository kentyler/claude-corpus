const express = require('express');
const request = require('supertest');
const { createMockPool } = require('../helpers/mocks');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const configRouteFactory = require('../../routes/config');

let pool, app, tmpDir;

beforeEach(async () => {
  pool = createMockPool();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-test-'));

  app = express();
  app.use(express.json());
  app.use('/api/config', configRouteFactory(tmpDir, pool));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('GET /api/config', () => {
  it('reads config from file', async () => {
    const config = { 'llm-registry': [{ id: 'test' }], other: true };
    await fs.writeFile(path.join(tmpDir, 'config.json'), JSON.stringify(config));

    const res = await request(app).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body['llm-registry']).toHaveLength(1);
    expect(res.body.other).toBe(true);
  });

  it('returns default config when file missing', async () => {
    const res = await request(app).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'llm-registry': [] });
  });

  it('returns 500 on non-ENOENT error', async () => {
    // Create a directory named config.json so reading it fails
    await fs.mkdir(path.join(tmpDir, 'config.json'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const res = await request(app).get('/api/config');
    consoleSpy.mockRestore();

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Failed to read config');
  });
});

describe('PUT /api/config', () => {
  it('writes config to file', async () => {
    const config = { 'llm-registry': [{ id: 'model1' }] };

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    const res = await request(app).put('/api/config').send(config);
    consoleSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify file was written
    const content = await fs.readFile(path.join(tmpDir, 'config.json'), 'utf8');
    expect(JSON.parse(content)).toEqual(config);
  });

  it('creates settings directory if needed', async () => {
    const nestedDir = path.join(tmpDir, 'sub', 'dir');
    // Recreate app with nested settings dir
    const nestedApp = express();
    nestedApp.use(express.json());
    nestedApp.use('/api/config', configRouteFactory(nestedDir, pool));

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    const res = await request(nestedApp).put('/api/config').send({ test: true });
    consoleSpy.mockRestore();

    expect(res.status).toBe(200);
    const content = await fs.readFile(path.join(nestedDir, 'config.json'), 'utf8');
    expect(JSON.parse(content)).toEqual({ test: true });
  });
});
