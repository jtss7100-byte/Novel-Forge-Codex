import 'dotenv/config';
import express from 'express';
import path from 'node:path';

async function startServer() {
  const app = express();
  const PORT = Number(process.env.DEV_SERVER_PORT || process.env.DEFAULT_APP_PORT || 3000);

  app.get('/api/health', (_req, res) => {
    res.status(200).json({ ok: true, status: 'ok' });
  });

  app.use(express.json({ limit: '15mb' }));

  const apiRouterPromise = import('./src/server/createApiRouter.ts').then((mod) =>
    mod.createApiRouter()
  );

  app.use(async (req, res, next) => {
    if (!req.path.startsWith('/api')) {
      next();
      return;
    }
    try {
      const apiRouter = await apiRouterPromise;
      apiRouter(req, res, next);
    } catch (err) {
      next(err);
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const viteReadyPromise = import('vite').then(({ createServer }) =>
      createServer({
        server: { middlewareMode: true },
        appType: 'spa',
      })
    );

    app.use(async (req, res, next) => {
      try {
        const vite = await viteReadyPromise;
        vite.middlewares(req, res, next);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`NOVEL FORGE server running on http://localhost:${PORT}`);
  });

  httpServer.on('error', (err) => {
    console.error(`NOVEL FORGE server failed to bind on port ${PORT}:`, err);
    process.exit(1);
  });
}

startServer().catch((err) => {
  console.error('NOVEL FORGE server startup error:', err);
  process.exit(1);
});
