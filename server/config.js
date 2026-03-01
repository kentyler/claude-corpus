/**
 * Configuration for Corpus backend
 *
 * Override with environment variables:
 *   DATABASE_URL or individual PG* variables
 */

const defaultHost = '127.0.0.1';

module.exports = function(secrets) {
  const pgPassword = process.env.PGPASSWORD || secrets?.database?.password || '';
  const pgUser = process.env.PGUSER || 'postgres';
  const pgHost = process.env.PGHOST || defaultHost;
  const pgPort = process.env.PGPORT || '5432';
  const pgDatabase = process.env.PGDATABASE || 'claude-corpus';
  const credentials = pgPassword ? `${pgUser}:${pgPassword}` : pgUser;

  return {
    // Database connection
    // Override with DATABASE_URL or individual PG* environment variables
    database: {
      connectionString: process.env.DATABASE_URL ||
        `postgresql://${credentials}@${pgHost}:${pgPort}/${pgDatabase}`,

      // Pool settings
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    },

    // Server settings
    server: {
      port: process.env.PORT || 3003,
    }
  };
};
