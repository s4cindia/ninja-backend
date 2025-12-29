import { Router } from 'express';
import { 
  getRemediationConfig, 
  updateRemediationConfig, 
  resetRemediationConfig 
} from '../config/remediation-config';

const router = Router();

router.get('/remediation', (req, res) => {
  const config = getRemediationConfig();
  res.json({
    success: true,
    data: config
  });
});

router.patch('/remediation', (req, res) => {
  const { colorContrastAutoFix } = req.body;
  
  const updates: Record<string, boolean> = {};
  if (typeof colorContrastAutoFix === 'boolean') {
    updates.colorContrastAutoFix = colorContrastAutoFix;
  }
  
  const config = updateRemediationConfig(updates);
  res.json({
    success: true,
    message: 'Remediation configuration updated',
    data: config
  });
});

router.post('/remediation/reset', (req, res) => {
  const config = resetRemediationConfig();
  res.json({
    success: true,
    message: 'Remediation configuration reset to defaults',
    data: config
  });
});

export default router;
