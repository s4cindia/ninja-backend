import { Router } from 'express';

const router = Router();

router.post('/register', (req, res) => {
  res.status(501).json({ message: 'Not implemented yet' });
});

router.post('/login', (req, res) => {
  res.status(501).json({ message: 'Not implemented yet' });
});

router.post('/logout', (req, res) => {
  res.status(501).json({ message: 'Not implemented yet' });
});

router.post('/refresh', (req, res) => {
  res.status(501).json({ message: 'Not implemented yet' });
});

router.get('/me', (req, res) => {
  res.status(501).json({ message: 'Not implemented yet' });
});

export default router;
