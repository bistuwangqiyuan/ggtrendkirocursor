/**
 * The recovery half of the payment drill, in the form the real job takes.
 *
 * netlify/functions/pipeline-drain-background.ts calls exactly these two
 * functions; running them from a tiny entry point lets the drill prove that a
 * payment taken during an outage really does land in Postgres afterwards,
 * without needing the Netlify runtime to schedule anything.
 */
import { drainBufferedPaymentEvents } from '../../src/lib/payments/orderBuffer';
import { applyPaymentEvent } from '../../src/lib/services/orders';

const summary = await drainBufferedPaymentEvents(async (event) => {
  await applyPaymentEvent(event);
});

console.log(
  `drained applied=${summary.applied} remaining=${summary.remaining}` +
  (summary.errors.length ? ` errors=${summary.errors.join('; ')}` : '')
);

process.exit(summary.errors.length === 0 ? 0 : 1);
