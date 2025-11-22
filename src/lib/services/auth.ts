import { query, queryOne } from '../db/client';
import { hashPassword, verifyPassword, generateSessionToken } from '../utils/security';
import { isValidEmail, isValidUsername, isValidPassword } from '../utils/validation';
import type { User, Session, Result, AuthError } from '../../types';

export class AuthService {
  async register(username: string, email: string, password: string): Promise<Result<User, AuthError>> {
    // 1. Validate input
    if (!isValidUsername(username)) {
        return { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username format', field: 'username' } };
    }
    if (!isValidEmail(email)) {
        return { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email format', field: 'email' } };
    }
    if (!isValidPassword(password)) {
        return { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid password format', field: 'password' } };
    }

    try {
      // 2. Check if user exists
      const existingUser = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1 OR username = $2', [email, username]);
      if (existingUser) {
        return { success: false, error: { code: 'USER_EXISTS', message: 'User already exists' } };
      }

      // 3. Hash password
      const passwordHash = await hashPassword(password);

      // 4. Create user
      const newUser = await queryOne<User>(
        `INSERT INTO users (username, email, password_hash) 
         VALUES ($1, $2, $3) 
         RETURNING id, username, email, locale, created_at as "createdAt", updated_at as "updatedAt", last_login_at as "lastLoginAt"`,
        [username, email, passwordHash]
      );

      if (!newUser) {
        throw new Error('Failed to create user');
      }

      return { success: true, data: newUser };
    } catch (error) {
      console.error('Registration error:', error);
      return { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Registration failed' } }; // Generic error for safety, log real one
    }
  }

  async login(email: string, password: string, ipAddress?: string, userAgent?: string): Promise<Result<{ session: Session; user: User }, AuthError>> {
    try {
      // 1. Find user
      const user = await queryOne<User & { password_hash: string }>(
        `SELECT id, username, email, password_hash, locale, created_at as "createdAt", updated_at as "updatedAt", last_login_at as "lastLoginAt" 
         FROM users WHERE email = $1`, 
        [email]
      );

      if (!user) {
        return { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } };
      }

      // 2. Verify password
      const isValid = await verifyPassword(password, user.password_hash);
      if (!isValid) {
        return { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } };
      }

      // 3. Create session
      const token = generateSessionToken();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      const session = await queryOne<Session>(
        `INSERT INTO sessions (user_id, token, expires_at, ip_address, user_agent) 
         VALUES ($1, $2, $3, $4, $5) 
         RETURNING id, user_id as "userId", token, expires_at as "expiresAt", created_at as "createdAt", ip_address as "ipAddress", user_agent as "userAgent"`,
        [user.id, token, expiresAt, ipAddress, userAgent]
      );

      if (!session) {
        throw new Error('Failed to create session');
      }

      // 4. Update last login
      await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

      // Remove password_hash from user object before returning
      const { password_hash, ...userWithoutPassword } = user;

      return { success: true, data: { session, user: userWithoutPassword } };
    } catch (error) {
      console.error('Login error:', error);
      // Ensure generic error message
      return { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Login failed' } };
    }
  }

  async logout(token: string): Promise<Result<void, AuthError>> {
    try {
      await query('DELETE FROM sessions WHERE token = $1', [token]);
      return { success: true, data: undefined };
    } catch (error) {
      console.error('Logout error:', error);
      return { success: false, error: { code: 'INVALID_TOKEN', message: 'Logout failed' } };
    }
  }

  async validateSession(token: string): Promise<Result<User, AuthError>> {
    try {
      const result = await queryOne<User & { expires_at: Date }>(
        `SELECT u.id, u.username, u.email, u.locale, u.created_at as "createdAt", u.updated_at as "updatedAt", u.last_login_at as "lastLoginAt", s.expires_at 
         FROM sessions s 
         JOIN users u ON s.user_id = u.id 
         WHERE s.token = $1`,
        [token]
      );

      if (!result) {
        return { success: false, error: { code: 'INVALID_TOKEN', message: 'Session not found' } };
      }

      if (new Date() > result.expires_at) {
        // Clean up expired session
        await this.logout(token);
        return { success: false, error: { code: 'SESSION_EXPIRED', message: 'Session expired' } };
      }

      const { expires_at, ...user } = result;
      return { success: true, data: user };
    } catch (error) {
      console.error('Session validation error:', error);
      return { success: false, error: { code: 'INVALID_TOKEN', message: 'Validation failed' } };
    }
  }
}

export const authService = new AuthService();

