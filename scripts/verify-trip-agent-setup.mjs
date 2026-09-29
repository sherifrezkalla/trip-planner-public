import { pathToFileURL } from 'node:url';
import { readConfiguration, smokeTripAgent, assertActiveSetup, safeFailure } from './smoke-trip-agent-mcp.mjs';

export async function verifyTripAgentSetup(env = process.env) {
  const { url } = readConfiguration(env);
  const slug = env.TRIP_SLUG?.trim();
  const token = env.TRIP_TOKEN?.trim();
  if (!slug || !/^[A-Za-z0-9_-]+$/.test(slug) || !token) throw new Error('Missing organizer configuration');
  const get = async path => {
    const response = await fetch(new URL(path, url.origin), {
      headers: { 'x-trip-token': token }, redirect: 'error', signal: AbortSignal.timeout(20_000), cache: 'no-store',
    });
    if (!response.ok) throw new Error('Organizer verification unavailable');
    return response.json();
  };
  const [setup, board] = await Promise.all([get(`/api/trips/${slug}/agent-connection`), get(`/api/trips/${slug}`)]);
  assertActiveSetup(setup, board);
  const smoke = await smokeTripAgent(env);
  if (smoke.state !== 'active' || !smoke.ready) throw new Error('Connector not active');
  const current = await get(`/api/trips/${slug}/agent-connection`);
  assertActiveSetup(current, board);
  if (current.connection.id !== setup.connection.id || current.connection.lifecycleGeneration !== setup.connection.lifecycleGeneration || current.connection.updatedAt !== setup.connection.updatedAt) throw new Error('Connection changed');
  return { ...smoke, organizerMapping: 'confirmed', privacyNotice: 'delivered' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await verifyTripAgentSetup())); }
  catch { console.error(safeFailure()); process.exitCode = 1; }
}
