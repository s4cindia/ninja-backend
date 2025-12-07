import { Router } from 'express';
import { config } from '../config';

const router = Router();

router.get('/', (req, res) => {
  res.json({
    name: 'Ninja Platform API',
    version: config.version,
    endpoints: {
      health: 'GET /health',
      auth: '/api/v1/auth/*',
      users: '/api/v1/users/*',
      products: '/api/v1/products/*',
      jobs: '/api/v1/jobs/*',
    },
  });
});

export default router;
