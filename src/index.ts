import express, { Express } from 'express';
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
import { startWorkers, stopWorkers } from './workers';
import { isRedisConfigured } from './config/redis.config';

const app: Express = express();

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return callback(null, true);
    const allowedPatterns = [
      /\.replit\.dev$/,
      /\.replit\.app$/,
      /\.repl\.co$/,
      /^https?:\/\/localhost(:\d+)?$/
    ];
    if (allowedPatterns.some(pattern => pattern.test(origin))) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
};

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
  console.log(`🚀 Ninja Backend v${config.version} running on port ${config.port}`);
  console.log(`📍 Environment: ${config.nodeEnv}`);
  console.log(`❤️  Health check: http://localhost:${config.port}/health`);
  console.log(`📚 API Base: http://localhost:${config.port}/api/v1`);
  
  if (isRedisConfigured()) {
    console.log('✅ Redis configured - BullMQ workers enabled');
  } else {
    console.log('⚠️  Redis not configured - running in sync mode');
  }
  
  startWorkers();
});

const gracefulShutdown = async () => {
  console.log('Shutting down gracefully...');
  
  server.close(async () => {
    console.log('HTTP server closed');
    
    await stopWorkers();
    
    await closeQueues();
    console.log('Queues closed');
    
    await closeRedisConnection();
    console.log('Redis connection closed');
    
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

export default app;
