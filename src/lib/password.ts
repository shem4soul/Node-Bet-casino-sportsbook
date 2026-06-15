import bcrypt from 'bcryptjs';

const rounds = () => Number(process.env.BCRYPT_ROUNDS || 12);

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, rounds());
}

export function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

let dummyHash: Promise<string> | null = null;

/**
 * Compares against a throwaway hash so a login for a non-existent account
 * takes as long as one for a real account (prevents user enumeration by timing).
 */
export async function burnPasswordCheck(plain: string): Promise<void> {
  dummyHash ??= bcrypt.hash('timing-equaliser', rounds());
  await bcrypt.compare(plain, await dummyHash);
}
