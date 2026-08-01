/**
 * Transactional email, used only for links a buyer asked for.
 *
 * WHY RESEND AND WHY SO LITTLE CODE
 * The site needs to send exactly two kinds of message: "here is a link to your
 * downloads" and "confirm this email belongs to your account". That is one HTTP
 * POST, so the SDK would be 300 KB of bundle for a `fetch` call. Resend's free
 * tier (3,000/month) is far above what a one-dollar product will need, and its
 * API is a single endpoint.
 *
 * NOT CONFIGURED IS A VALID STATE
 * Without an API key this module reports `sent: false` instead of throwing, and
 * the calling endpoint says so honestly rather than pretending a mail is on its
 * way. A guest can still download immediately after paying — the emailed link is
 * for coming back later — so a missing key degrades one recovery path, it does
 * not break the purchase.
 */

const API = 'https://api.resend.com/emails';

export interface SendResult {
  sent: boolean;
  id?: string;
  error?: string;
}

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY?.trim();
}

/**
 * Verified sending identity. Resend refuses anything else, so this must match a
 * domain verified in the Resend dashboard.
 */
function fromAddress(): string {
  return process.env.EMAIL_FROM?.trim() || 'ioni.top <no-reply@ioni.top>';
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return { sent: false, error: 'RESEND_API_KEY not configured' };

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromAddress(),
        to: [input.to],
        subject: input.subject,
        html: input.html,
        // A plain-text part is not decoration: without one, a link-only HTML mail
        // is a strong spam signal, and this mail is useless in the spam folder.
        text: input.text,
      }),
    });
    const body = await res.text();
    if (!res.ok) return { sent: false, error: `${res.status} ${body.slice(0, 200)}` };
    const json = JSON.parse(body) as { id?: string };
    return { sent: true, id: json.id };
  } catch (error) {
    return { sent: false, error: (error as Error).message };
  }
}

/** Minimal, deliberately plain markup: styled mail is what looks like phishing. */
export function magicLinkEmail(
  locale: 'en' | 'zh',
  kind: 'orders' | 'claim',
  link: string
): { subject: string; html: string; text: string } {
  const zh = locale === 'zh';
  const subject = zh
    ? kind === 'orders'
      ? 'ioni.top 下载链接'
      : 'ioni.top 订单认领确认'
    : kind === 'orders'
      ? 'Your ioni.top downloads'
      : 'Confirm your ioni.top order claim';

  const lead = zh
    ? kind === 'orders'
      ? '点击下面的链接查看并下载你购买的报告：'
      : '点击下面的链接，把你以此邮箱购买的订单关联到你的账号：'
    : kind === 'orders'
      ? 'Open the link below to view and re-download the reports you bought:'
      : 'Open the link below to attach the orders bought with this email address to your account:';

  const expiry = zh ? '链接 15 分钟内有效，只能由你使用。' : 'The link is valid for 15 minutes and is meant only for you.';
  const ignore = zh ? '如果这不是你发起的请求，忽略这封邮件即可。' : 'If you did not request this, you can ignore this email.';

  return {
    subject,
    text: `${lead}\n\n${link}\n\n${expiry}\n${ignore}`,
    html:
      `<p>${lead}</p>` +
      `<p><a href="${link}">${link}</a></p>` +
      `<p style="color:#666;font-size:13px">${expiry}<br>${ignore}</p>`,
  };
}
