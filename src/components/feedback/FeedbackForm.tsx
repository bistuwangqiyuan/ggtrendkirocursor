import React, { useState } from 'react';

interface FeedbackFormProps {
  locale: 'zh' | 'en';
  translations: any;
  user?: { name?: string; email?: string };
}

export function FeedbackForm({ locale, translations, user }: FeedbackFormProps) {
  const t = translations.feedback;
  
  const [formData, setFormData] = useState({
    name: user?.name || '',
    email: user?.email || '',
    subject: '',
    message: ''
  });
  
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStatus('idle');
    setErrorMsg('');

    try {
      const res = await fetch('/api/feedback/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      
      const data = await res.json();
      
      if (data.success) {
        setStatus('success');
        setFormData({ name: user?.name || '', email: user?.email || '', subject: '', message: '' });
      } else {
        setStatus('error');
        // If validation errors, show first one or generic
        if (data.validationErrors) {
           const firstKey = Object.keys(data.validationErrors)[0];
           setErrorMsg(`${firstKey}: ${data.validationErrors[firstKey]}`);
        } else {
           setErrorMsg(data.error || t.error);
        }
      }
    } catch (err) {
      setStatus('error');
      setErrorMsg(t.error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} class="space-y-6 bg-gray-900/50 border border-gray-800 p-6 rounded-xl">
      {status === 'success' && (
        <div class="bg-green-500/10 border border-green-500/20 text-green-400 px-4 py-3 rounded-md">
          {t.success}
        </div>
      )}
      
      {status === 'error' && (
        <div class="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-md">
          {errorMsg}
        </div>
      )}

      <div>
        <label htmlFor="name" class="block text-sm font-medium text-gray-300 mb-1">{t.name}</label>
        <input
          type="text"
          id="name"
          name="name"
          required
          minLength={2}
          maxLength={100}
          value={formData.name}
          onChange={handleChange}
          class="w-full bg-gray-800 border border-gray-700 text-white rounded-md px-4 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
        />
      </div>

      <div>
        <label htmlFor="email" class="block text-sm font-medium text-gray-300 mb-1">{t.email}</label>
        <input
          type="email"
          id="email"
          name="email"
          required
          value={formData.email}
          onChange={handleChange}
          class="w-full bg-gray-800 border border-gray-700 text-white rounded-md px-4 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
        />
      </div>

      <div>
        <label htmlFor="subject" class="block text-sm font-medium text-gray-300 mb-1">{t.subject}</label>
        <input
          type="text"
          id="subject"
          name="subject"
          required
          minLength={5}
          maxLength={200}
          value={formData.subject}
          onChange={handleChange}
          class="w-full bg-gray-800 border border-gray-700 text-white rounded-md px-4 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
        />
      </div>

      <div>
        <label htmlFor="message" class="block text-sm font-medium text-gray-300 mb-1">{t.message}</label>
        <textarea
          id="message"
          name="message"
          rows={5}
          required
          minLength={10}
          maxLength={2000}
          value={formData.message}
          onChange={handleChange}
          class="w-full bg-gray-800 border border-gray-700 text-white rounded-md px-4 py-2 focus:ring-2 focus:ring-blue-500 outline-none resize-none"
        ></textarea>
      </div>

      <button
        type="submit"
        disabled={loading}
        class="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex justify-center"
      >
        {loading ? (
          <svg class="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        ) : (
          t.submit
        )}
      </button>
    </form>
  );
}

