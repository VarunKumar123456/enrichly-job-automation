import request from 'supertest';
import { app } from '../src/index';
import { pool } from '../src/db';

describe('API (end-to-end against real app + Postgres)', () => {
  const email = `api-test-${Date.now()}@test.local`;
  let token: string;
  let jobId: string;

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE email = $1', [email]);
    await pool.end();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/jobs');
    expect(res.status).toBe(401);
  });

  it('registers a user and returns a token', async () => {
    const res = await request(app).post('/api/auth/register').send({ email, password: 'testpassword123' });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    token = res.body.token;
  });

  it('rejects duplicate registration', async () => {
    const res = await request(app).post('/api/auth/register').send({ email, password: 'testpassword123' });
    expect(res.status).toBe(409);
  });

  it('creates a job', async () => {
    const res = await request(app)
      .post('/api/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ping example.com', targetUrl: 'https://example.com', httpMethod: 'GET' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Ping example.com');
    expect(res.body.version).toBe(1);
    jobId = res.body.id;
  });

  it('rejects a job update with a stale version (optimistic locking / concurrent edit conflict)', async () => {
    // Simulate two clients both loading version 1, one saves first...
    const firstEdit = await request(app)
      .put(`/api/jobs/${jobId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ping example.com (renamed by client A)', version: 1 });
    expect(firstEdit.status).toBe(200);
    expect(firstEdit.body.version).toBe(2);

    // ...then the second client tries to save using the now-stale version 1.
    const secondEdit = await request(app)
      .put(`/api/jobs/${jobId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ping example.com (renamed by client B)', version: 1 });
    expect(secondEdit.status).toBe(409);
  });

  it('triggers a manual run and dedupes a second click with the same Idempotency-Key', async () => {
    const key = `test-key-${Date.now()}`;
    const first = await request(app)
      .post(`/api/jobs/${jobId}/run`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send();
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/jobs/${jobId}/run`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send();
    expect(second.status).toBe(200);
    expect(second.body.deduped).toBe(true);
  });

  it('blocks a second run with a DIFFERENT idempotency key while one is already in flight', async () => {
    // Unlike the same-key case above (silently deduped), a genuinely new
    // trigger attempt while one is in flight is a real conflict and should
    // surface as 409, not be swallowed — the caller asked for a distinct run.
    const res = await request(app)
      .post(`/api/jobs/${jobId}/run`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `different-key-${Date.now()}`)
      .send();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has an execution in progress/i);
  });

  it('returns job stats without an ambiguous-column error', async () => {
    const res = await request(app)
      .get(`/api/jobs/${jobId}/stats`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('succeeded');
    expect(res.body).toHaveProperty('failed');
  });

  it('lists execution history for the job', async () => {
    const res = await request(app)
      .get(`/api/executions/job/${jobId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects retrying an execution that is not FAILED', async () => {
    const history = await request(app)
      .get(`/api/executions/job/${jobId}`)
      .set('Authorization', `Bearer ${token}`);
    const pendingExec = history.body[0];
    const res = await request(app)
      .post(`/api/executions/${pendingExec.id}/retry`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
