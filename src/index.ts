import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import config from './config';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    version: config.version
  });
});

app.get('/', (req: Request, res: Response) => {
  res.json({
    message: 'Welcome to Ninja Platform API',
    version: config.version,
    endpoints: {
      health: '/health',
      api: '/api'
    }
  });
});

app.get('/api', (req: Request, res: Response) => {
  res.json({
    name: 'Ninja Platform API',
    version: config.version,
    description: 'AI-powered accessibility and compliance checking tool',
    status: 'operational'
  });
});

app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

app.use((err: Error & { status?: number }, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: config.nodeEnv === 'production' ? 'An error occurred' : err.message
  });
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`🚀 Ninja Backend running on port ${config.port}`);
  console.log(`📍 Environment: ${config.nodeEnv}`);
  console.log(`❤️  Health check: http://localhost:${config.port}/health`);
});
