import express, { Request } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import routes from './routes';
import mockPaystackRoutes from './mockGateway/mockPaystackRoutes';
import { errorHandler } from './middleware/errorHandler';

const app = express();

app.use(helmet());
app.use(cors());

// The `verify` hook stashes the exact raw request bytes on req.rawBody
// before body-parsing touches them. Webhook signature checks MUST run
// against these raw bytes — re-serializing the parsed JSON object can
// change key order/whitespace and silently break signature verification.
app.use(
  express.json({
    verify: (req: Request, _res, buf: Buffer) => {
      req.rawBody = buf;
    },
  })
);

// Global baseline limiter; individual routes add stricter limits where it matters.
app.use(rateLimit({ windowMs: 60 * 1000, max: 300 }));

app.use('/api', routes);

// Stand-in payment gateway, for local/testing use only — see
// src/mockGateway/mockPaystackRoutes.ts. Delete this line (and the
// module) when wiring up a real provider.
app.use('/mock-paystack', mockPaystackRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

export default app;
