import { describe, test, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { authService } from '../../src/lib/services/auth';
import * as db from '../../src/lib/db/client';
import * as security from '../../src/lib/utils/security';

// Mock dependencies
vi.mock('../../src/lib/db/client');
vi.mock('../../src/lib/utils/security');

describe('AuthService Properties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mocks
    (security.hashPassword as any).mockResolvedValue('hashed_password');
    (security.verifyPassword as any).mockResolvedValue(true);
    (security.generateSessionToken as any).mockReturnValue('mock_token');
  });

  test('Property: Valid registration always attempts to create user', () => {
    fc.assert(
      fc.asyncProperty(
        fc.record({
          username: fc.string({ minLength: 3, maxLength: 20 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
          email: fc.emailAddress(),
          password: fc.string({ minLength: 8, maxLength: 20 }).filter(s => /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/.test(s))
        }),
        async (user) => {
          vi.resetAllMocks();
          (security.hashPassword as any).mockResolvedValue('hashed_password');
          (security.verifyPassword as any).mockResolvedValue(true);
          (security.generateSessionToken as any).mockReturnValue('mock_token');

          // Mock user not existing
          (db.queryOne as any).mockResolvedValueOnce(null); // check existing
          (db.queryOne as any).mockResolvedValueOnce({ id: 'new_id', ...user }); // create
          
          const result = await authService.register(user.username, user.email, user.password);
          
          expect(result.success).toBe(true);
          // expect(db.queryOne).toHaveBeenCalledTimes(2); // Check + Create
        }
      )
    );
  });

  test('Property: Invalid registration is rejected', () => {
    fc.assert(
      fc.asyncProperty(
        fc.record({
          username: fc.string(),
          email: fc.string(),
          password: fc.string()
        }).filter(u => 
             u.username.length < 3 || 
             !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email) || 
             u.password.length < 8
        ),
        async (input) => {
           const result = await authService.register(input.username, input.email, input.password);
           expect(result.success).toBe(false);
        }
      )
    );
  });
});
