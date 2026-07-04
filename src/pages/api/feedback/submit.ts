import type { APIRoute } from 'astro';
import { feedbackService } from '../../../lib/services/feedback';
import { ValidationRules, isValidEmail, sanitizeInput } from '../../../lib/utils/validation';
import { rateLimit, rateLimitResponse, clientIpFromRequest } from '../../../lib/utils/rateLimit';

export const POST: APIRoute = async ({ request, locals }) => {
  // Spam baseline: 5 feedback submissions per IP per minute.
  const rl = rateLimit(`feedback:${clientIpFromRequest(request)}`, 5, 60_000);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const body = await request.json();
    const { name, email, subject, message } = body;

    // Validation
    const errors: Record<string, string> = {};
    if (!name || name.length < ValidationRules.feedbackName.minLength || name.length > ValidationRules.feedbackName.maxLength) {
      errors.name = 'Invalid name length';
    }
    if (!isValidEmail(email)) {
      errors.email = 'Invalid email format';
    }
    if (!subject || subject.length < ValidationRules.feedbackSubject.minLength || subject.length > ValidationRules.feedbackSubject.maxLength) {
      errors.subject = 'Invalid subject length';
    }
    if (!message || message.length < ValidationRules.feedbackMessage.minLength || message.length > ValidationRules.feedbackMessage.maxLength) {
      errors.message = 'Invalid message length';
    }

    if (Object.keys(errors).length > 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Validation failed',
        validationErrors: errors
      }), { status: 400 });
    }

    // Sanitize
    const sanitizedInput = {
      name: sanitizeInput(name),
      email: sanitizeInput(email), // though email is already validated format
      subject: sanitizeInput(subject),
      message: sanitizeInput(message),
      userId: locals.user?.id
    };

    const result = await feedbackService.submitFeedback(sanitizedInput);

    if (!result.success) {
      return new Response(JSON.stringify({
        success: false,
        error: result.error.message
      }), { status: 500 });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Feedback submitted successfully'
    }), { status: 201 });

  } catch (error) {
    console.error('Feedback API error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Internal server error'
    }), { status: 500 });
  }
};

