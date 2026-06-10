import React, { useState } from 'react';

interface NewsletterFormProps {
  translations: {
    placeholder: string;
    submit: string;
    success: string;
    error: string;
    alreadySubscribed: string;
  };
}

export function NewsletterForm({ translations: t }: NewsletterFormProps) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error' | 'duplicate'>('idle');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus('loading');
    try {
      const res = await fetch('/api/newsletter/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setStatus('success');
        setEmail('');
      } else if (data.error === 'already_subscribed') {
        setStatus('duplicate');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  };

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex gap-2 mt-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t.placeholder}
          required
          className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          disabled={status === 'loading' || status === 'success'}
        />
        <button
          type="submit"
          disabled={status === 'loading' || status === 'success'}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60 transition-colors shrink-0"
        >
          {t.submit}
        </button>
      </form>
      {status === 'success' && <p className="text-green-400 text-xs mt-2">{t.success}</p>}
      {status === 'duplicate' && <p className="text-yellow-400 text-xs mt-2">{t.alreadySubscribed}</p>}
      {status === 'error' && <p className="text-red-400 text-xs mt-2">{t.error}</p>}
    </div>
  );
}
