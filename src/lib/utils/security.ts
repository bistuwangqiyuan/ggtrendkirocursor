import bcrypt from 'bcryptjs';
// import crypto from 'crypto'; // Node built-in

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

export function generateSessionToken(): string {
  // Basic implementation using random characters
  // In a node environment we can use crypto
  // return crypto.randomBytes(32).toString('hex');
  
  // Since we might run in edge functions or diverse envs, ensure compatibility.
  // But 'crypto' is usually available in Node and modern Edge runtimes.
  // Let's try standard Web Crypto API if available, or Node crypto.
  
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      // Use UUID + random suffix for simple robust token
      return `${crypto.randomUUID()}-${Math.random().toString(36).substring(2)}`;
  }
  
  // Fallback for node (if global crypto not set, though it usually is in recent node)
  const nodeCrypto = require('node:crypto');
  return nodeCrypto.randomBytes(32).toString('hex');
}

