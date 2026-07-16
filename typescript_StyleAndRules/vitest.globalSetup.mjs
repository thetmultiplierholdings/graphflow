import { ensureTestDatabase, isTestDatabaseDisabled } from './scripts/ensure-test-db.ts';

export async function setup() {
  if (isTestDatabaseDisabled()) {
    console.log('ENVIRONMENT_NO_DATABASE detected — skipping global database setup.');
    return;
  }

  // Ensure database is running before any tests start
  await ensureTestDatabase();
}

export async function teardown() {
  // We intentionally leave the database running for faster subsequent test runs
  // Developers can manually stop it with: docker-compose -f infra/local/docker-compose.yml -p multiplier down
}
