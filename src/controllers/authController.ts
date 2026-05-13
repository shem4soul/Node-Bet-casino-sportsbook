import { Request, Response } from 'express';
import * as authService from '../services/authService';
import { asyncHandler } from '../utils/asyncHandler';

export const register = asyncHandler(async (req: Request, res: Response) => {
  const { username, email, password, dateOfBirth } = req.body;
  const result = await authService.register({ username, email, password, dateOfBirth });
  res.status(201).json(result);
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { identifier, password } = req.body;
  const result = await authService.login({ identifier, password });
  res.json(result);
});
