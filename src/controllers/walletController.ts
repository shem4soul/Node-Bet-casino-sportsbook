import { Request, Response } from 'express';
import * as walletService from '../services/walletService';
import * as paymentService from '../services/paymentService';
import * as userRepo from '../repositories/userRepository';
import { pool } from '../config/db';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';

export const getBalance = asyncHandler(async (req: Request, res: Response) => {
  const wallet = await walletService.getBalance(req.user!.id);
  res.json(wallet);
});

// Starts a deposit through the (mock) payment gateway. The wallet is
// credited later, only once the signed webhook confirms the charge —
// see paymentService.handleWebhook and routes/webhookRoutes.ts.
export const initializeDeposit = asyncHandler(async (req: Request, res: Response) => {
  const user = await userRepo.findById(pool, req.user!.id);
  if (!user) throw new AppError('User not found', 404);
  const result = await paymentService.initializeDeposit(req.user!.id, {
    amount: Number(req.body.amount),
    email: user.email,
  });
  res.status(201).json(result);
});

export const getDepositStatus = asyncHandler(async (req: Request, res: Response) => {
  const intent = await paymentService.getDepositStatus(req.user!.id, req.params.reference);
  res.json(intent);
});

export const withdraw = asyncHandler(async (req: Request, res: Response) => {
  const balance = await walletService.withdraw(req.user!.id, Number(req.body.amount));
  res.json({ balance });
});

export const getTransactions = asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset } = req.query;
  const rows = await walletService.getTransactions(req.user!.id, {
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  res.json(rows);
});
