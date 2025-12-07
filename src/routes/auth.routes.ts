import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { registerSchema, loginSchema, refreshTokenSchema } from '../schemas';

const router = Router();

router.post('/register', validate({ body: registerSchema }), (req, res, next) => authController.register(req, res, next));

router.post('/login', validate({ body: loginSchema }), (req, res, next) => authController.login(req, res, next));

router.post('/logout', (req, res) => authController.logout(req, res));

router.post('/refresh', validate({ body: refreshTokenSchema }), (req, res, next) => authController.refresh(req, res, next));

router.get('/me', authenticate, (req, res, next) => authController.me(req, res, next));

export default router;
