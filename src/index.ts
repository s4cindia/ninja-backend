import express, { Express } from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { config } from './config';
import { requestLogger } from './middleware/request-logger.middleware';
import { errorHandler } from './middleware/error-handler.middleware';
import { notFoundHandler } from './middleware/not-found.middleware';
import routes from './routes';
import { closeQueues } from './queues';
import { closeRedisConnection } from './lib/redis';
import { startBackgroundWorkers, stopBackgroundWorkers, startWorkflowQueueWorker, stopWorkflowQueueWorker } from './workers';
import { startWorkflowRecovery, stopWorkflowRecovery } from './services/workflow/workflow-recovery.service';
import { isRedisConfigured } from './config/redis.config';
import { sseService } from './sse/sse.service';
import { websocketService } from './services/workflow/websocket.service';
import { logger } from './lib/logger';
import { integrityCheckService } from './services/integrity/integrity-check.service';
import { plagiarismCheckService } from './services/plagiarism/plagiarism-check.service';
import { getWorkerFlags } from './config/process-role';

// Web/worker process split -- see the doc comment on config.processRole.
// null (unset) is the legacy/monolith default: runs both the HTTP server
// AND every BullMQ worker, exactly like before this split existed.
const processRole = config.processRole;
const { runsBackgroundWorkers, runsWorkflowWorker } = getWorkerFlags(processRole);

const app: Express = express();

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    logger.debug(`CORS check - Origin: ${origin}, Allowed origins: ${config.corsOrigins.join(', ')}`);
    if (!origin) return callback(null, true);

    // Check against configured origins from CORS_ORIGINS env var
    if (config.corsOrigins.includes(origin)) {
      logger.debug('CORS - Origin allowed via config.corsOrigins');
      return callback(null, true);
    }

    // Also allow Replit development domains, localhost, and CloudFront
    const allowedPatterns = [
      /\.replit\.dev\/?$/,
      /\.replit\.app\/?$/,
      /\.repl\.co\/?$/,
      /\.cloudfront\.net\/?$/,
      /^https?:\/\/localhost(:\d+)?$/,
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/
    ];
    if (allowedPatterns.some(pattern => pattern.test(origin))) {
      return callback(null, true);
    }

    logger.warn(`CORS blocked origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Type'],
  // Cap preflight cache at 10 minutes so a bad preflight during an ECS task
  // swap can't poison browser caches for the UA default (Chrome 2h, FF 24h).
  maxAge: 600,
};

app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", 'ws:', 'wss:', 'http:', 'https:'],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(compression());

app.use(requestLogger);

app.get('/health', (req, res) => {
  const redisAvailable = isRedisConfigured();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    version: config.version,
    commitSha: process.env.COMMIT_SHA || 'unknown',
    role: processRole ?? 'legacy',
    redis: redisAvailable ? 'connected' : 'not_configured',
    workers: redisAvailable ? 'enabled' : 'disabled',
    websocket: {
      enabled: config.features.enableWebSocket,
      connections: config.features.enableWebSocket ? websocketService.getConnectionCount() : 0,
      rooms: config.features.enableWebSocket ? websocketService.getRoomCount() : 0,
    },
  });
});

app.use('/api/v1', routes);

app.use(notFoundHandler);
app.use(errorHandler);

let server: http.Server;

if (processRole === 'worker') {
  // Worker role: the full Express app above is built (cheap, declarative)
  // but deliberately never given a listening socket -- none of its routes
  // are reachable over the network from this process. A minimal raw HTTP
  // listener exists ONLY so the Dockerfile's existing
  // `HEALTHCHECK CMD curl -f http://localhost:3000/health` keeps working
  // unmodified. No ALB is ever attached to this service's task definition
  // (see infrastructure/ecs/ninja-backend-worker-task-definition.json), so
  // nothing but that local Docker probe ever reaches this port.
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: config.nodeEnv,
        version: config.version,
        commitSha: process.env.COMMIT_SHA || 'unknown',
        role: 'worker',
        redis: isRedisConfigured() ? 'connected' : 'not_configured',
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'This is the worker process -- it serves no API routes' } }));
  });

  server.listen(config.port, '0.0.0.0', () => {
    logger.info(`🚀 Ninja Backend Worker v${config.version} running on port ${config.port} (PROCESS_ROLE=worker)`);
    logger.info(`❤️  Health check: http://localhost:${config.port}/health`);

    if (isRedisConfigured()) {
      logger.info('✅ Redis configured - BullMQ workers enabled');
    } else {
      logger.warn('⚠️  Redis not configured - running in sync mode');
    }

    // Needed for its Redis-subscribe side effect even though this process
    // never serves an SSE HTTP route itself -- batch-remediation/
    // batch-processing publish progress via sseService.broadcastToChannel,
    // which silently falls back to a useless local-only broadcast unless
    // initialize() ran in this process too.
    sseService.initialize().catch(err => {
      logger.error('Failed to initialize SSE service', err as Error);
    });

    startBackgroundWorkers();

    if (isRedisConfigured()) {
      startWorkflowRecovery();
      logger.info('✅ Workflow recovery scanner started');
    }
  });
} else {
  server = app.listen(config.port, '0.0.0.0', () => {
    // Extend timeout for large PDF processing (default 120s is too short)
    server.timeout = parseInt(process.env.SERVER_TIMEOUT_MS || '120000', 10);
    server.keepAliveTimeout = parseInt(process.env.SERVER_TIMEOUT_MS || '120000', 10);
    logger.info(`🚀 Ninja Backend v${config.version} running on port ${config.port}${processRole ? ` (PROCESS_ROLE=${processRole})` : ''}`);
    logger.info(`📍 Environment: ${config.nodeEnv}`);
    logger.info(`❤️  Health check: http://localhost:${config.port}/health`);
    logger.info(`📚 API Base: http://localhost:${config.port}/api/v1`);

    if (isRedisConfigured()) {
      logger.info('✅ Redis configured - BullMQ workers enabled');
    } else {
      logger.warn('⚠️  Redis not configured - running in sync mode');
    }

    sseService.initialize().catch(err => {
      logger.error('Failed to initialize SSE service', err as Error);
    });

    if (config.features.enableWebSocket) {
      websocketService.initialize(server);
      logger.info('✅ WebSocket service initialized');
    } else {
      logger.info('⚠️  WebSocket service disabled (ENABLE_WEBSOCKET=false)');
    }

    // workflow-processing's worker stays on this (web/legacy) process --
    // its processor calls websocketService directly, and websocketService.io
    // is only ever set here, where initialize(server) just ran above.
    if (runsWorkflowWorker) {
      startWorkflowQueueWorker();
    }

    // 'web' role explicitly does NOT run background workers -- that's the
    // whole point of the split (see PROCESS_ROLE doc comment on config).
    // Only legacy (unset) still runs everything in one process.
    if (runsBackgroundWorkers) {
      startBackgroundWorkers();

      if (isRedisConfigured()) {
        startWorkflowRecovery();
        logger.info('✅ Workflow recovery scanner started');
      }
    }

    // Startup health check: make a real Claude API call to verify connectivity
    (async () => {
      try {
        const { claudeService } = await import('./services/ai/claude.service');
        const result = await claudeService.healthCheck();
        if (result.healthy) {
          logger.info(`✅ Claude API health check passed: ${JSON.stringify(result.details)}`);
        } else {
          logger.error(`❌ Claude API health check FAILED: ${JSON.stringify(result.details)}`);
        }
      } catch (err) {
        logger.error(`❌ Claude API health check error: ${err}`);
      }
    })();

    // Recover stale jobs left in PROCESSING/QUEUED from previous crashes/deploys
    integrityCheckService.cleanupStaleJobs().catch(err => {
      logger.error('Failed to clean up stale integrity check jobs', err as Error);
    });
    plagiarismCheckService.cleanupStaleJobs().catch(err => {
      logger.error('Failed to clean up stale plagiarism check jobs', err as Error);
    });
  });
}

const gracefulShutdown = async () => {
  logger.info('Shutting down gracefully...');

  server.close(async () => {
    logger.info(processRole === 'worker' ? 'Worker HTTP listener closed' : 'HTTP server closed');

    if (runsBackgroundWorkers) {
      stopWorkflowRecovery();
      await stopBackgroundWorkers();
    }
    if (runsWorkflowWorker) {
      await stopWorkflowQueueWorker();
    }

    await closeQueues();
    logger.info('Queues closed');

    await closeRedisConnection();
    logger.info('Redis connection closed');

    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Safety net: confirmed live that a rejected promise with no attached
// .catch() anywhere in the call chain (e.g. a fire-and-forget progress
// callback whose Prisma/Redis call fails transiently -- see
// accessibility.processor.ts's onProgress/onValidatorComplete for the actual
// bug this caught) crashes the ENTIRE process on Node 15+, taking down the
// API and every other in-flight job, not just the one promise. That
// crash-and-restart is exactly what src/workers/index.ts's
// cleanupStaleActiveJobs() records as "Server restarted while job was
// processing" on the next boot.
//
// unhandledRejection: log and keep running -- deliberately, not an
// oversight. CodeRabbit flagged this on the PR that introduced it, arguing
// ECS could keep serving a process after an "uncontained failure" since
// /health doesn't check worker state; the suggested fix was to exit(1) here
// too. Not applied: a rejected promise doesn't leave the process in a
// known-corrupted state the way a synchronous throw does (Node's own
// unhandledException guidance doesn't extend to it), so it's a fundamentally
// different risk than uncaughtException below. Exiting on every unhandled
// rejection would reintroduce exactly the failure mode this handler exists
// to fix: the NEXT unguarded fire-and-forget call anywhere in this large
// codebase would still take down every other in-flight job and the whole
// API, just with a clean log line first instead of a silent crash. Logging
// and continuing costs nothing when the rejection really was isolated (the
// common case), and still surfaces every occurrence for investigation.
//
// uncaughtException: different risk profile, different response. Node's own
// guidance is that resuming after a genuine synchronous throw escaping every
// try/catch is unsafe -- some part of the stack may be in an inconsistent
// state. Log it and exit deliberately so ECS replaces the task with a clean
// one, instead of crashing silently with no log line at all (which is what
// made the original incident hard to diagnose).
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection (process continuing)', {
    reason: reason instanceof Error ? reason.stack ?? reason.message : reason,
    promise: String(promise),
  });
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception — exiting for a clean restart: ${err.message}`, err);
  process.exit(1);
});

export default app;
