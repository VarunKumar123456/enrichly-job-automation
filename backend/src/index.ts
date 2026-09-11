import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/authRoutes';
import jobRoutes from './routes/jobRoutes';
import executionRoutes from './routes/executionRoutes';
import { errorHandler, notFoundHandler } from './errors';
import { startScheduler } from './scheduler';

dotenv.config();

export const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/executions', executionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

if (require.main === module) {
  const port = parseInt(process.env.PORT || '4000', 10);
  app.listen(port, () => {
    console.log(`[api] listening on :${port}`);
    if (process.env.RUN_SCHEDULER_IN_API !== 'false') {
      startScheduler();
    }
  });
}
