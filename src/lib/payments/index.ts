/**
 * Provider selection and the fallback that makes a failed provider a retry
 * rather than a lost sale.
 */
import { creem } from './creem';
import { lemonsqueezy } from './lemonsqueezy';
import type { CheckoutRequest, CheckoutSession, PaymentAdapter, PaymentProvider } from './types';

export * from './types';

const ADAPTERS: Record<PaymentProvider, PaymentAdapter> = {
  creem,
  lemonsqueezy,
};

/** The advertised price, in cents. Kept here only so the UI and the receipt copy
 * agree; the amount actually charged is configured on the provider's product. */
export function priceCents(): number {
  const raw = Number(process.env.PAYMENT_PRICE_CENTS);
  return Number.isFinite(raw) && raw >= 100 ? Math.floor(raw) : 100;
}

export function priceLabel(): string {
  const cents = priceCents();
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

export function adapterFor(provider: string): PaymentAdapter | undefined {
  return ADAPTERS[provider as PaymentProvider];
}

/**
 * Providers in the order they should be tried, most preferred first.
 *
 * A provider is only offered when its webhook can also be verified. Selling
 * through a provider whose signing secret is missing would take the buyer's money
 * and leave the site unable to prove the payment happened — the one failure mode
 * with no acceptable recovery.
 */
export function availableAdapters(): PaymentAdapter[] {
  const order = (process.env.PAYMENT_PROVIDER_ORDER || 'creem,lemonsqueezy')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ordered = order.map(adapterFor).filter((a): a is PaymentAdapter => !!a);
  // Anything not named in the order list still counts, appended, so forgetting to
  // update the variable cannot silently disable a configured provider.
  for (const adapter of Object.values(ADAPTERS)) {
    if (!ordered.includes(adapter)) ordered.push(adapter);
  }
  return ordered.filter((a) => a.configured() && a.webhookConfigured());
}

export function paymentsEnabled(): boolean {
  return availableAdapters().length > 0;
}

export interface CheckoutAttempt {
  provider: PaymentProvider;
  error: string;
}

export interface CheckoutOutcome {
  session: CheckoutSession | null;
  /** Providers that were tried and failed, in order, for the ops log. */
  failures: CheckoutAttempt[];
}

/**
 * Open a checkout session, falling through to the next provider on failure.
 *
 * Every failure is reported even on success, because a working fallback hides a
 * broken primary: without this list, Creem could be down for a week while
 * revenue looked normal.
 */
export async function createCheckout(request: CheckoutRequest): Promise<CheckoutOutcome> {
  const failures: CheckoutAttempt[] = [];
  for (const adapter of availableAdapters()) {
    try {
      const session = await adapter.createCheckout(request);
      return { session, failures };
    } catch (error) {
      failures.push({ provider: adapter.provider, error: (error as Error).message });
    }
  }
  return { session: null, failures };
}
