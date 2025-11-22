export const ValidationRules = {
  username: {
    minLength: 3,
    maxLength: 20,
    pattern: /^[a-zA-Z0-9_-]+$/,
    message: {
      zh: '用户名必须为 3-20 个字符，只能包含字母、数字、下划线和连字符',
      en: 'Username must be 3-20 characters and contain only letters, numbers, underscores, and hyphens'
    }
  },
  email: {
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    message: {
      zh: '请输入有效的邮箱地址',
      en: 'Please enter a valid email address'
    }
  },
  password: {
    minLength: 8,
    maxLength: 128,
    pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/,
    message: {
      zh: '密码必须至少 8 个字符，包含大小写字母和数字',
      en: 'Password must be at least 8 characters with uppercase, lowercase, and numbers'
    }
  },
  feedbackName: {
    minLength: 2,
    maxLength: 100,
    message: {
      zh: '姓名必须为 2-100 个字符',
      en: 'Name must be 2-100 characters'
    }
  },
  feedbackSubject: {
    minLength: 5,
    maxLength: 200,
    message: {
      zh: '主题必须为 5-200 个字符',
      en: 'Subject must be 5-200 characters'
    }
  },
  feedbackMessage: {
    minLength: 10,
    maxLength: 2000,
    message: {
      zh: '消息内容必须为 10-2000 个字符',
      en: 'Message must be 10-2000 characters'
    }
  }
};

export function isValidEmail(email: string): boolean {
  if (!email || email.length > 255) return false;
  return ValidationRules.email.pattern.test(email);
}

export function isValidUsername(username: string): boolean {
  if (!username || username.length < ValidationRules.username.minLength || username.length > ValidationRules.username.maxLength) return false;
  return ValidationRules.username.pattern.test(username);
}

export function isValidPassword(password: string): boolean {
  if (!password || password.length < ValidationRules.password.minLength || password.length > ValidationRules.password.maxLength) return false;
  return ValidationRules.password.pattern.test(password);
}

// Simple sanitizer to prevent basic XSS in strings
export function sanitizeInput(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

