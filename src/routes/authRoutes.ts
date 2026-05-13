import express from 'express';
import rateLimit from 'express-rate-limit';
import * as authController from '../controllers/authController';

const router = express.Router();

// Slow down credential-stuffing / brute-force attempts
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);

export default router;
