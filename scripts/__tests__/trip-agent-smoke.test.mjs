import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfiguration, assertInventory, assertActiveSetup, safeFailure, smokeTripAgent } from '../smoke-trip-agent-mcp.mjs';
import { verifyTripAgentSetup } from '../verify-trip-agent-setup.mjs';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import names from '../../lib/trip-agent-tool-names.json' with { type: 'json' };

const env = { TRIP_AGENT_MCP_URL: 'https://planner.example/api/mcp', TRIP_AGENT_CREDENTIAL: 'a'.repeat(43), TRIP_AGENT_GROUP_ID: '123@g.us' };
test('requires explicit secure endpoint, bearer and stable group identifier', () => {
  assert.equal(readConfiguration(env).groupId, '123@g.us');
  for (const url of ['http://planner.example/api/mcp', 'https://user:pass@planner.example/api/mcp', 'https://planner.example/api/mcp?token=x', 'https://planner.example/api/mcp#x', 'https://planner.example/other']) {
    assert.throws(() => readConfiguration({ ...env, TRIP_AGENT_MCP_URL: url }));
  }
  assert.throws(() => readConfiguration({ ...env, TRIP_AGENT_CREDENTIAL: '' }));
  assert.throws(() => readConfiguration({ ...env, TRIP_AGENT_GROUP_ID: '' }));
});
test('inventory rejects missing, extra, and duplicate tools', () => {
  const tools = names.map(name => ({ name }));
  assertInventory(tools);
  for (const invalid of [tools.slice(1), [...tools, { name: 'admin' }], [...tools, tools[0]]]) assert.throws(() => assertInventory(invalid));
});
test('active verification requires actual registration, receipt and human organizer mapping', () => {
  const connection = { status: 'active', groupRegistered: true, privacyNoticeDelivered: true, activatedAt: '2026-09-23T10:00:00Z' };
  const mappings = [{ status: 'confirmed', travelerId: 'organizer' }];
  const board = { me: { id: 'organizer', isOrganizer: true }, travelers: [{ id: 'organizer', isOrganizer: true, isBot: false }] };
  assertActiveSetup({ connection, mappings }, board);
  for (const patch of [{ status: 'paired' }, { groupRegistered: false }, { privacyNoticeDelivered: false }, { activatedAt: null }]) assert.throws(() => assertActiveSetup({ connection: { ...connection, ...patch }, mappings }, board));
  assert.throws(() => assertActiveSetup({ connection, mappings: [] }, board));
  assert.throws(() => assertActiveSetup({ connection, mappings }, { ...board, travelers: [{ ...board.travelers[0], isBot: true }] }));
});
test('failure output never echoes untrusted errors or credentials', () => {
  assert.equal(safeFailure(new Error('Bearer secret http://private.test')), 'Trip-agent verification failed. Check endpoint, credentials, group, permissions, and connection status. No trip changes were requested.');
});

function mockGateway(t, { paired = false, tripSlug = 'summer', extraTool = false, setupScope = true, contextError, readiness = { ready: true, missing: [] } } = {}) {
  const calls = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'smoke-test', version: '1' });
    for (const name of [...names, ...(extraTool ? ['unexpected_admin'] : [])]) server.registerTool(name, {
      inputSchema: z.object({ requestId: z.string().uuid(), externalGroupId: z.literal(env.TRIP_AGENT_GROUP_ID) }).strict(),
    }, async args => {
      calls.push({ name, args });
      const result = name === 'get_trip_agent_readiness'
        ? setupScope ? { ok: true, data: readiness } : { ok: false, error: { code: 'missing_scope' } }
        : contextError || paired ? { ok: false, error: { code: contextError || 'connection_not_active' } }
          : { ok: true, data: { trip: { slug: tripSlug } } };
      return { isError: !result.ok, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
    return server;
  }, { legacy: 'reject' });
  const setup = { connection: { id: 'connection', lifecycleGeneration: 1, updatedAt: 'v1', status: 'active', groupRegistered: true, privacyNoticeDelivered: true, activatedAt: '2026-09-23T10:00:00Z' }, mappings: [{ status: 'confirmed', travelerId: 'organizer' }] };
  const board = { me: { id: 'organizer', isOrganizer: true }, travelers: [{ id: 'organizer', isOrganizer: true, isBot: false }] };
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, 'https://planner.example');
    assert.equal(request.redirect, 'error');
    if (new URL(request.url).pathname === '/api/mcp') {
      assert.equal(request.headers.get('authorization'), `Bearer ${env.TRIP_AGENT_CREDENTIAL}`);
      return handler.fetch(request);
    }
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.get('x-trip-token'), 'organizer-test-token');
    return Response.json(request.url.endsWith('/agent-connection') ? setup : board);
  });
  return calls;
}

test('active MCP smoke succeeds without setup scope and only reads context', async t => {
  const calls = mockGateway(t, { setupScope: false });
  assert.deepEqual(await smokeTripAgent(env), { state: 'active', ready: true, toolCount: 12 });
  assert.deepEqual(calls.map(c => c.name), ['get_trip_context']);
});
test('paired smoke reports paired rather than claiming activation', async t => {
  const calls = mockGateway(t, { paired: true, readiness: { ready: false, missing: ['privacy_notice'] } });
  assert.deepEqual(await smokeTripAgent(env), { state: 'paired', ready: false, toolCount: 12 });
  assert.deepEqual(calls.map(c => c.name), ['get_trip_context', 'get_trip_agent_readiness']);
});
test('context permission and service errors fail without a readiness fallback', async t => {
  for (const contextError of ['missing_scope', 'connection_unavailable', 'database_unavailable']) {
    await t.test(contextError, async t => {
      const calls = mockGateway(t, { contextError });
      await assert.rejects(smokeTripAgent(env));
      assert.deepEqual(calls.map(c => c.name), ['get_trip_context']);
    });
  }
});
test('paired smoke fails when setup readiness is refused', async t => {
  const calls = mockGateway(t, { paired: true, setupScope: false });
  await assert.rejects(smokeTripAgent(env));
  assert.deepEqual(calls.map(c => c.name), ['get_trip_context', 'get_trip_agent_readiness']);
});
test('active smoke verifies the optional expected trip slug', async t => {
  mockGateway(t, { setupScope: false });
  assert.equal((await smokeTripAgent({ ...env, TRIP_SLUG: 'summer' })).state, 'active');
  await assert.rejects(smokeTripAgent({ ...env, TRIP_SLUG: 'different' }));
});
test('unknown tool inventory fails before calling any tool', async t => {
  const calls = mockGateway(t, { extraTool: true });
  await assert.rejects(smokeTripAgent(env));
  assert.equal(calls.length, 0);
});
test('setup verification combines organizer evidence with the matching active trip', async t => {
  mockGateway(t);
  const result = await verifyTripAgentSetup({ ...env, TRIP_SLUG: 'summer', TRIP_TOKEN: 'organizer-test-token' });
  assert.equal(result.privacyNotice, 'delivered');
  assert.equal(result.organizerMapping, 'confirmed');
});
test('a credential for another trip cannot pass organizer verification', async t => {
  mockGateway(t, { tripSlug: 'different' });
  await assert.rejects(verifyTripAgentSetup({ ...env, TRIP_SLUG: 'summer', TRIP_TOKEN: 'organizer-test-token' }));
});
