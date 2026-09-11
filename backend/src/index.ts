import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { errorHandler, notFoundHandler } from './errors';
import authRoutes from './routes/authRoutes';
import executionRoutes from './routes/executionRoutes';
import jobRoutes from './routes/jobRoutes';
import { startScheduler } from './scheduler';
import { startWorker, stopWorker } from './worker';

dotenv.config();

export const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/executions', executionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

if (require.main === module) {
  const port = parseInt(process.env.PORT || '4000', 10);

  const server = app.listen(port, () => {
    console.log(`[api] listening on :${port}`);

    if (process.env.RUN_SCHEDULER_IN_API !== 'false') {
      startScheduler();
    }

    if (process.env.RUN_WORKER_IN_API !== 'false') {
      startWorker();
    }
  });

  const shutdown = () => {
    console.log('[api] shutting down');

    stopWorker();

    server.close(() => {
      console.log('[api] HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}