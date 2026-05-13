import express from 'express';
import * as walletController from '../controllers/walletController';
import { requireAuth } from '../middleware/auth';

const router = express.Router();

router.use(requireAuth);
router.get('/balance', walletController.getBalance);
router.post('/deposit/initialize', walletController.initializeDeposit);
router.get('/deposit/:reference/status', walletController.getDepositStatus);
router.post('/withdraw', walletController.withdraw);
router.get('/transactions', walletController.getTransactions);

export default router;
