import { pool, withTransaction } from '../config/db';
import * as userRepo from '../repositories/userRepository';
import { hashPassword, comparePassword } from '../utils/password';
import { signToken } from '../utils/jwt';
import { AppError } from '../middleware/errorHandler';
import { startingDemoBalance } from '../config/env';

const MIN_AGE_YEARS = 18;

function isAdult(dateOfBirth: string): boolean {
  const dob = new Date(dateOfBirth);
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - MIN_AGE_YEARS);
  return dob <= cutoff;
}

export interface RegisterParams {
  username: string;
  email: string;
  password: string;
  dateOfBirth: string;
}

export async function register({ username, email, password, dateOfBirth }: RegisterParams) {
  if (!username || !email || !password || !dateOfBirth) {
    throw new AppError('username, email, password and dateOfBirth are required', 400);
  }
  if (!isAdult(dateOfBirth)) {
    throw new AppError('You must be at least 18 years old to register', 403);
  }

  const existing = await userRepo.findByEmailOrUsername(pool, email);
  const existingByUsername = await userRepo.findByEmailOrUsername(pool, username);
  if (existing || existingByUsername) {
    throw new AppError('Username or email already in use', 409);
  }

  const passwordHash = await hashPassword(password);

  const userId = await withTransaction(async (conn) => {
    const id = await userRepo.createUser(conn, { username, email, passwordHash, dateOfBirth });
    // Demo starting balance — remove/zero this out once real payment
    // processing (deposits) is wired up.
    await userRepo.createWallet(conn, id, startingDemoBalance);
    return id;
  });

  const token = signToken({ sub: userId, username, role: 'user' });
  return { id: userId, username, email, token };
}

export interface LoginParams {
  identifier: string;
  password: string;
}

export async function login({ identifier, password }: LoginParams) {
  const user = await userRepo.findByEmailOrUsername(pool, identifier);
  if (!user) throw new AppError('Invalid credentials', 401);

  const valid = await comparePassword(password, user.password_hash);
  if (!valid) throw new AppError('Invalid credentials', 401);

  if (user.status !== 'active') {
    throw new AppError(`Account is ${user.status}`, 403);
  }

  const token = signToken({ sub: user.id, username: user.username, role: user.role });
  return { id: user.id, username: user.username, email: user.email, role: user.role, token };
}
