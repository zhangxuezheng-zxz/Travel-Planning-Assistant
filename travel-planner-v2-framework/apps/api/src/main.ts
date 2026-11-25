import { createApp } from './app';
import { ConfigService } from './config/config.service';

async function bootstrap() {
  const app = await createApp();
  app.enableShutdownHooks();
  const config = app.get(ConfigService).values;
  await app.listen(
    config.port,
    config.verification.mode === 'local' ? '127.0.0.1' : process.env.API_HOST || '0.0.0.0',
  );
}

void bootstrap().catch(() => {
  console.error('API startup failed. Check configuration and whether the port is available.');
  process.exitCode = 1;
});
