const express = require('express');
const request = require('supertest');
const { createMockPool } = require('../helpers/mocks');

const eventsRouteFactory = require('../../routes/events');

let pool, mockLogEvent, app;

beforeEach(() => {
  pool = createMockPool();
  mockLogEvent = jest.fn().mockResolvedValue(undefined);

  app = express();
  app.use(express.json());
  app.use('/api/events', eventsRouteFactory(pool, mockLogEvent));
});

describe('POST /api/events', () => {
  it('logs event and returns success', async () => {
    const res = await request(app)
      .post('/api/events')
      .send({ event_type: 'info', source: 'test', message: 'Test event', details: { key: 'val' } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockLogEvent).toHaveBeenCalledWith(
      pool, 'info', 'test', 'Test event', { details: { key: 'val' } }
    );
  });

  it('defaults source to ui', async () => {
    const res = await request(app)
      .post('/api/events')
      .send({ event_type: 'action', message: 'click' });

    expect(res.status).toBe(200);
    expect(mockLogEvent.mock.calls[0][2]).toBe('ui');
  });

  it('returns 400 when event_type missing', async () => {
    const res = await request(app)
      .post('/api/events')
      .send({ message: 'no type' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('event_type and message are required');
  });

  it('returns 400 when message missing', async () => {
    const res = await request(app)
      .post('/api/events')
      .send({ event_type: 'info' });

    expect(res.status).toBe(400);
  });

  it('returns 500 when logEvent throws', async () => {
    mockLogEvent.mockRejectedValueOnce(new Error('db error'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const res = await request(app)
      .post('/api/events')
      .send({ event_type: 'info', message: 'test' });
    consoleSpy.mockRestore();

    expect(res.status).toBe(500);
  });
});

describe('GET /api/events', () => {
  it('returns events with default pagination', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, event_type: 'info', message: 'test' }]
    });

    const res = await request(app).get('/api/events');

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    // Default limit 50, offset 0
    const params = pool.query.mock.calls[0][1];
    expect(params).toContain(50);
    expect(params).toContain(0);
  });

  it('respects limit and offset params', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/events?limit=10&offset=20');

    const params = pool.query.mock.calls[0][1];
    expect(params).toContain(10);
    expect(params).toContain(20);
  });

  it('caps limit at 500', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/events?limit=9999');

    const params = pool.query.mock.calls[0][1];
    expect(params).toContain(500);
  });

  it('filters by type', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/events?type=error');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('event_type = $1');
    expect(params[0]).toBe('error');
  });

  it('filters by source', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/events?source=server');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('source = $1');
    expect(params[0]).toBe('server');
  });

  it('filters by both type and source', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/events?type=error&source=server');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('event_type = $1');
    expect(sql).toContain('source = $2');
    expect(params[0]).toBe('error');
    expect(params[1]).toBe('server');
  });

  it('returns 500 on database error', async () => {
    pool.query.mockRejectedValueOnce(new Error('query failed'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const res = await request(app).get('/api/events');
    consoleSpy.mockRestore();

    expect(res.status).toBe(500);
  });
});
