import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../config/db';
import { asyncHandler, clientIp, idParam, paginationSchema } from '../lib/http';
import { notFound } from '../lib/errors';
import { validate } from '../middleware/validate';
import { requireAuth, requireCanGamble } from '../middleware/auth';
import { paymentLimiter } from '../middleware/rateLimit';
import * as walletRepo from '../repositories/walletRepository';
import * as payments from '../services/paymentService';
import * as withdrawals from '../services/withdrawalService';

const router = Router();
router.use(requireAuth);

const amount = z.number().positive().multipleOf(0.01).max(1_000_000_000);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const w = await walletRepo.getWallet(pool, req.user!.id);
    if (!w) throw notFound('Wallet');
    res.json({ balance: w.balance, currency: w.currency, updatedAt: w.updated_at });
  })
);

router.get(
  '/transactions',
  validate({
    query: paginationSchema.extend({
      type: z
        .enum([
          'deposit',
          'withdrawal',
          'withdrawal_reversal',
          'bet_stake',
          'bet_payout',
          'bet_void_refund',
          'bet_cashout',
          'game_stake',
          'game_payout',
          'adjustment',
        ])
        .optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(await walletRepo.listTransactions(pool, req.user!.id, req.query as any));
  })
);

// ---- Deposits (Paystack) ----

router.post(
  '/deposits',
  requireCanGamble,
  paymentLimiter,
  validate({ body: z.object({ amount }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await payments.initializeDeposit({ id: req.user!.id, email: req.user!.email }, req.body.amount));
  })
);

router.get(
  '/deposits',
  validate({ query: paginationSchema }),
  asyncHandler(async (req, res) => {
    res.json(await payments.listDeposits(req.user!.id, req.query as any));
  })
);

router.get(
  '/deposits/:reference',
  asyncHandler(async (req, res) => {
    res.json(await payments.getDeposit(req.user!.id, req.params.reference));
  })
);

/** Call after Paystack redirects back to your app — confirms with Paystack and credits if paid. */
router.post(
  '/deposits/:reference/verify',
  paymentLimiter,
  asyncHandler(async (req, res) => {
    res.json(await payments.verifyDeposit(req.user!.id, req.params.reference));
  })
);

// ---- Banks & payout accounts ----

router.get(
  '/banks',
  asyncHandler(async (_req, res) => {
    res.json(await withdrawals.listBanks());
  })
);

router.get(
  '/bank-accounts',
  asyncHandler(async (req, res) => {
    res.json(await withdrawals.listBankAccounts(req.user!.id));
  })
);

router.post(
  '/bank-accounts',
  paymentLimiter,
  validate({
    body: z.object({
      bankCode: z.string().min(2).max(10),
      accountNumber: z.string().regex(/^\d{10}$/, 'NUBAN account numbers are 10 digits'),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await withdrawals.addBankAccount(req.user!.id, req.body.bankCode, req.body.accountNumber, clientIp(req)));
  })
);

router.delete(
  '/bank-accounts/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await withdrawals.removeBankAccount(req.user!.id, Number(req.params.id));
    res.status(204).end();
  })
);

// ---- Withdrawals ----

router.post(
  '/withdrawals',
  paymentLimiter,
  validate({ body: z.object({ amount, bankAccountId: z.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await withdrawals.requestWithdrawal(req.user!, req.body.amount, req.body.bankAccountId, clientIp(req)));
  })
);

router.get(
  '/withdrawals',
  validate({ query: paginationSchema }),
  asyncHandler(async (req, res) => {
    res.json(await withdrawals.listWithdrawals(req.user!.id, req.query as any));
  })
);

router.get(
  '/withdrawals/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await withdrawals.getWithdrawal(req.user!.id, Number(req.params.id)));
  })
);

export default router;
