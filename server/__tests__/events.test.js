const { logEvent, logError } = require('../lib/events');
const { createMockPool } = require('./helpers/mocks');

describe('logEvent', () => {
  it('inserts event with correct parameters', async () => {
    const pool = createMockPool();

    await logEvent(pool, 'info', 'test-source', 'Test message', {
      databaseId: 1,
      userId: 'user1',
      sessionId: 'sess1',
      details: { key: 'value' }
    });

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO shared.events');
    expect(params).toEqual([
      'info', 'test-source', 1, 'user1', 'sess1', 'Test message', '{"key":"value"}'
    ]);
  });

  it('passes null for optional fields when not provided', async () => {
    const pool = createMockPool();

    await logEvent(pool, 'warning', 'src', 'msg');

    const [, params] = pool.query.mock.calls[0];
    expect(params[2]).toBeNull(); // databaseId
    expect(params[3]).toBeNull(); // userId
    expect(params[4]).toBeNull(); // sessionId
    expect(params[6]).toBeNull(); // details
  });

  it('swallows database errors without throwing', async () => {
    const pool = createMockPool();
    pool.query.mockRejectedValueOnce(new Error('connection lost'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    // Should not throw
    await logEvent(pool, 'error', 'src', 'msg');

    expect(consoleSpy).toHaveBeenCalledWith(
      'Failed to log event:', 'connection lost'
    );
    consoleSpy.mockRestore();
  });
});

describe('logError', () => {
  it('delegates to logEvent with error details', async () => {
    const pool = createMockPool();
    const error = new Error('something broke');

    await logError(pool, 'test-source', 'Operation failed', error, {
      details: { extra: 'info' }
    });

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [, params] = pool.query.mock.calls[0];
    expect(params[0]).toBe('error'); // event_type
    expect(params[1]).toBe('test-source');
    expect(params[5]).toBe('Operation failed');

    const details = JSON.parse(params[6]);
    expect(details.error).toBe('something broke');
    expect(details.stack).toContain('something broke');
    expect(details.extra).toBe('info');
  });

  it('handles null error gracefully', async () => {
    const pool = createMockPool();

    await logError(pool, 'src', 'msg', null);

    const [, params] = pool.query.mock.calls[0];
    const details = JSON.parse(params[6]);
    expect(details.error).toBeUndefined();
    expect(details.stack).toBeUndefined();
  });
});
