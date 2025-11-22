import { queryOne } from '../db/client';
import type { Feedback, FeedbackInput, Result, DatabaseError } from '../../types';
import { ValidationRules } from '../utils/validation';

export class FeedbackService {
  async submitFeedback(input: FeedbackInput): Promise<Result<Feedback, DatabaseError>> {
    // Input validation (redundant with API but safe)
    if (!input.name || input.name.length < ValidationRules.feedbackName.minLength) {
        return { success: false, error: { code: 'QUERY_ERROR', message: 'Invalid name' } };
    }

    try {
      const feedback = await queryOne<Feedback>(
        `INSERT INTO feedback (name, email, subject, message, user_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, email, subject, message, status, created_at as "createdAt"`,
        [input.name, input.email, input.subject, input.message, input.userId || null]
      );

      if (!feedback) {
        throw new Error('Failed to create feedback');
      }

      return { success: true, data: feedback };
    } catch (error) {
      console.error('Submit feedback error:', error);
      return { success: false, error: { code: 'QUERY_ERROR', message: 'Failed to submit feedback' } };
    }
  }
}

export const feedbackService = new FeedbackService();

