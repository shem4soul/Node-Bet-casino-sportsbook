import type { UserRole, UserStatus, KycStatus } from './db';

export interface AuthUser {
  id: number;
  role: UserRole;
  username: string;
  email: string;
  status: UserStatus;
  kycStatus: KycStatus;
  selfExclusionUntil: Date | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      rawBody?: Buffer;
    }
  }
}

export {};
