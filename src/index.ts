import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';
import { config } from './config';
import { requestLogger } from './middleware/request-logger.middleware';
import { errorHandler } from './middleware/error-handler.middleware';
import { notFoundHandler } from './middleware/not-found.middleware';
import routes from './routes';
import { closeQueues } from './queues';
import { closeRedisConnection } from './lib/redis';
import { startWorkers, stopWorkers } from './workers';
import { isRedisConfigured } from './config/redis.config';
import { sseService } from './sse/sse.service';
import { logger } from './lib/logger';

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
};

app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(compression());

app.use(requestLogger);

app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  },
}));

app.get('/', (_req, res) => {
  res.redirect('/stylesheet-analysis.html');
});

app.get('/health', (req, res) => {
  const redisAvailable = isRedisConfigured();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    version: config.version,
    redis: redisAvailable ? 'connected' : 'not_configured',
    workers: redisAvailable ? 'enabled' : 'disabled',
  });
});

app.use('/api/v1', routes);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info(`🚀 Ninja Backend v${config.version} running on port ${config.port}`);
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
  
  startWorkers();
});

const gracefulShutdown = async () => {
  logger.info('Shutting down gracefully...');
  
  server.close(async () => {
    logger.info('HTTP server closed');
    
    await stopWorkers();
    
    await closeQueues();
    logger.info('Queues closed');
    
    await closeRedisConnection();
    logger.info('Redis connection closed');
    
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

export default app;
