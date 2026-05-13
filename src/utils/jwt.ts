import jwt from 'jsonwebtoken';
import { jwtSecret, jwtExpiresIn } from '../config/env';

export interface TokenPayload {
  sub: number;
  username: string;
  role: string;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, jwtSecret, { expiresIn: jwtExpiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload {
  const payload = jwt.verify(token, jwtSecret);
  return payload as unknown as TokenPayload;
}
