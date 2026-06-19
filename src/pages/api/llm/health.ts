import type { APIRoute } from 'astro';
import { getLlmEndpointStatus, warmResolvedModels } from '../../../lib/services/llm';

export const prerender = false;

/**
 * Read-only diagnostics for the LLM rotation. Reports which endpoints are
 * configured, their auto-upgrade family/rank, and their current failover state.
 * Never exposes API keys.
 *
 * Pass ?resolve=1 to probe each provider's /models endpoint and report the
 * auto-upgraded model currently selected (result is cached ~12h).
 */
export const GET: APIRoute = async ({ url }) => {
  if (url.searchParams.get('resolve') === '1') {
    await warmResolvedModels();
  }
  const status = getLlmEndpointStatus();
  return new Response(
    JSON.stringify({ success: true, ...status }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};
