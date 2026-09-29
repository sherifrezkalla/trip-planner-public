import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import toolNames from '../lib/trip-agent-tool-names.json' with { type: 'json' };

export function readConfiguration(env = process.env) {
  const url = new URL(env.TRIP_AGENT_MCP_URL || 'invalid');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/api/mcp') throw new Error('Invalid endpoint');
  const credential = env.TRIP_AGENT_CREDENTIAL?.trim();
  const groupId = env.TRIP_AGENT_GROUP_ID?.trim();
  if (!credential || !/^[A-Za-z0-9_-]{43}$/.test(credential) || !groupId || groupId === '*') throw new Error('Missing connector configuration');
  return { url, credential, groupId };
}

export function assertInventory(tools) {
  const actual = tools.map(tool => tool.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...toolNames].sort())) throw new Error('Tool inventory mismatch');
}

export function safeFailure() {
  // Never echo an SDK, HTTP, validation or provider error: these can contain
  // headers, raw responses, URLs, participant IDs, or credential fragments.
  return 'Trip-agent verification failed. Check endpoint, credentials, group, permissions, and connection status. No trip changes were requested.';
}

function toolData(result) {
  if (result.isError || result.structuredContent?.ok !== true) throw new Error('Tool refused verification');
  return result.structuredContent.data;
}

export async function smokeTripAgent(env = process.env) {
  const { url, credential, groupId } = readConfiguration(env);
  const client = new Client({ name: 'trip-planner-read-only-smoke', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${credential}` }, redirect: 'error' },
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(20_000)]) }),
  });
  try {
    await client.connect(transport);
    const inventory = await client.listTools();
    if (inventory.nextCursor) throw new Error('Unexpected inventory pagination');
    assertInventory(inventory.tools);
    const envelope = () => ({ requestId: crypto.randomUUID(), externalGroupId: groupId });
    const context = await client.callTool({ name: 'get_trip_context', arguments: envelope() });
    if (context.isError === true && context.structuredContent?.ok === false && context.structuredContent.error?.code === 'connection_not_active') {
      const readiness = toolData(await client.callTool({ name: 'get_trip_agent_readiness', arguments: envelope() }));
      if (typeof readiness.ready !== 'boolean' || !Array.isArray(readiness.missing)) throw new Error('Unexpected readiness');
      return { toolCount: toolNames.length, state: 'paired', ready: readiness.ready };
    }
    const data = toolData(context);
    if (env.TRIP_SLUG && data.trip?.slug !== env.TRIP_SLUG) throw new Error('Wrong trip');
    return { toolCount: toolNames.length, state: 'active', ready: true };
  } finally {
    await client.close();
  }
}

export function assertActiveSetup(setup, board) {
  const connection = setup.connection;
  const organizer = board.travelers?.find(traveler => traveler.id === board.me?.id && traveler.isOrganizer === true && traveler.isBot === false);
  if (!organizer || board.me?.isOrganizer !== true || connection?.status !== 'active' || connection.groupRegistered !== true || connection.privacyNoticeDelivered !== true || !connection.activatedAt
    || !setup.mappings?.some(mapping => mapping.status === 'confirmed' && mapping.travelerId === organizer.id)) throw new Error('Setup incomplete');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await smokeTripAgent())); }
  catch { console.error(safeFailure()); process.exitCode = 1; }
}
