import type { APIRoute } from 'astro';
import { getLlmEndpointStatus } from '../../../lib/services/llm';

export const prerender = false;

/**
 * Read-only diagnostics for the LLM rotation. Reports which endpoints are
 * configured and their current failover/cooldown state. Never exposes API keys.
 */
export const GET: APIRoute = async () => {
  const status = getLlmEndpointStatus();
  return new Response(
    JSON.stringify({ success: true, ...status }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};
