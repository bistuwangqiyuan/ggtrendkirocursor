const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidNewsletterEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim()) && email.trim().length <= 255;
}
