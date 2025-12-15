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

const app: Express = express();

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
}));

app.options('*', cors());

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'unsafe-none' },
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(compression());

app.use(requestLogger);

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    version: config.version,
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
