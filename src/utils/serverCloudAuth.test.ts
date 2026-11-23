import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createApiRouter } from '../server/createApiRouter';

test('local API requires Firebase authentication when configured for cloud Firestore', async () => {
  const envKeys = [
    'NODE_ENV',
    'NODE_TEST_CONTEXT',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'FIREBASE_SERVICE_ACCOUNT_KEY',
    'GCLOUD_PROJECT',
    'GOOGLE_CLOUD_PROJECT',
    'K_SERVICE',
    'FIRESTORE_EMULATOR_HOST',
    'FIREBASE_AUTH_EMULATOR_HOST',
    'NOVELFORGE_ENFORCE_CLOUD_AUTH',
    'NOVEL_FORGE_ENFORCE_CLOUD_AUTH',
    'SERVER_FORCE_CLOUD_AUTH',
  ];
  const previousEnv = envKeys.map((key) => [key, process.env[key]] as const);
  for (const key of envKeys) delete process.env[key];
  process.env.NODE_ENV = 'development';
  process.env.NOVELFORGE_ENFORCE_CLOUD_AUTH = 'false';

  const app = express();
  app.use(express.json());
  app.use(createApiRouter());
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    // No project ID, so this exercises the auth guard without reaching Firestore or RAG.
    const ragStatus = () => fetch(`${origin}/api/rag/status`, { method: 'POST' });
    assert.equal((await ragStatus()).status, 400, 'offline development uses local auth mode');

    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'not-a-real-service-account.json';
    assert.equal((await ragStatus()).status, 401, 'cloud credentials require a Firebase token');

    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    const verify = await fetch(`${origin}/api/auth/verify`, {
      headers: { authorization: 'Bearer offline-test-placeholder' },
    });
    assert.equal(verify.status, 200);
    const result = await verify.json();
    assert.equal(result.verified, false);
    assert.match(result.message, /AUTH_EMULATOR_ISOLATION_REQUIRED/);

    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    assert.equal((await ragStatus()).status, 400, 'loopback emulator preserves local development');

    process.env.NODE_ENV = 'production';
    assert.equal((await ragStatus()).status, 401, 'production always requires a Firebase token');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
