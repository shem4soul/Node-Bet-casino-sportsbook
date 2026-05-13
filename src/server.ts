import app from './app';
import { port } from './config/env';
import { startOddsSyncScheduler } from './jobs/oddsSyncScheduler';

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`casino-sportsbook-api listening on port ${port}`);
  startOddsSyncScheduler();
});
