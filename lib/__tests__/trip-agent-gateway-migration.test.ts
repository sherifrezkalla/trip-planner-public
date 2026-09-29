import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ids = {
  trip: "10000000-0000-4000-8000-000000000001",
  otherTrip: "10000000-0000-4000-8000-000000000002",
  traveler: "20000000-0000-4000-8000-000000000001",
  otherTraveler: "20000000-0000-4000-8000-000000000002",
  tripTraveler: "20000000-0000-4000-8000-000000000003",
  alternateTripTraveler: "20000000-0000-4000-8000-000000000004",
};

const digest = (character: string) => character.repeat(64);

let db: PGlite;

async function applyMigrations(database: PGlite) {
  await database.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;

    -- Supabase owns this schema in hosted projects. PGlite starts as plain
    -- PostgreSQL, so model the platform table before applying app migrations.
    create schema storage;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
  `);
  const directory = resolve(process.cwd(), "supabase/migrations");
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    try {
      await database.exec(readFileSync(resolve(directory, file), "utf8"));
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
    }
  }
}

async function seedTripsAndTravelers() {
  await db.query(
    `insert into trips (id, slug, destination_name, destination_place_id, lat, lng, start_date, end_date, budget_level)
     values
       ($1, 'gateway-trip', 'Example City', 'example-city', 50.7, 7.1, '2026-09-01', '2026-09-07', 'mid'),
       ($2, 'other-gateway-trip', 'Cologne', 'cologne', 50.9, 6.9, '2026-09-01', '2026-09-07', 'mid')`,
    [ids.trip, ids.otherTrip],
  );
  await db.query(
    `insert into travelers (id, trip_id, display_name, token, interests, pace, dietary, is_organizer)
     values
       ($1, $5, 'Organizer', 'gateway-organizer-token', array['art'], 'balanced', 'none', true),
       ($2, $6, 'Other traveler', 'other-gateway-token', array['food'], 'balanced', 'none', false),
       ($3, $5, 'Trip traveler', 'gateway-trip-token', array['food'], 'balanced', 'none', false),
       ($4, $5, 'Alternate traveler', 'gateway-alternate-token', array['nature'], 'balanced', 'none', false)`,
    [ids.traveler, ids.otherTraveler, ids.tripTraveler, ids.alternateTripTraveler, ids.trip, ids.otherTrip],
  );
}

async function insertConnection(
  tripId = ids.trip,
  pairingDigest = digest("a"),
  provider = "openclaw",
) {
  const result = await db.query<{ id: string }>(
    `insert into trip_agent_connections (trip_id, provider, pairing_code_digest, pairing_expires_at)
     values ($1, $2, $3, '2026-09-03T22:30:00Z')
     returning id`,
    [tripId, provider, pairingDigest],
  );
  return result.rows[0].id;
}

async function pairConnection(connectionId: string) {
  await db.query(
    `update trip_agent_connections
     set status = 'paired', credential_digest = $2, pairing_code_digest = null,
         pairing_expires_at = null, paired_at = '2026-09-03T22:00:00Z'
     where id = $1`,
    [connectionId, digest("c")],
  );
}

async function transitionMapping(input: {
  connectionId: string;
  lifecycleGeneration?: number;
  tripId?: string;
  mappingId: string;
  actorId?: string;
  action: "confirm" | "remap" | "revoke";
  travelerId?: string | null;
  expectedUpdatedAt: string | Date;
  expectedStatus: "suggested" | "confirmed" | "revoked";
  expectedTravelerId?: string | null;
  at?: string;
}) {
  return db.query<{
    id: string;
    traveler_id: string | null;
    status: string;
    updated_at: Date;
  }>(
    `select * from transition_trip_agent_participant_mapping(
       $1::uuid, $2::uuid, $3::integer, $4::uuid, $5::uuid, $6::text,
       $7::uuid, $8::timestamptz, $9::text, $10::uuid, $11::timestamptz
     )`,
    [
      input.connectionId,
      input.tripId ?? ids.trip,
      input.lifecycleGeneration ?? 1,
      input.mappingId,
      input.actorId ?? ids.traveler,
      input.action,
      input.travelerId ?? null,
      input.expectedUpdatedAt,
      input.expectedStatus,
      input.expectedTravelerId ?? null,
      input.at ?? "2026-09-04T12:00:00Z",
    ],
  );
}

async function insertAction(connectionId: string, overrides: {
  tripId?: string;
  idempotencyKey?: string;
  operation?: string;
} = {}) {
  return db.query<{ id: string }>(
    `insert into trip_agent_actions
       (connection_id, trip_id, idempotency_key, external_actor_digest, operation,
        normalized_request, authority_decision, status, announcement_status)
     values ($1, $2, $3, $4, $5, '{"dayIndex":0}'::jsonb, 'allowed', 'received', 'pending')
     returning id`,
    [
      connectionId,
      overrides.tripId ?? ids.trip,
      overrides.idempotencyKey ?? "request-1",
      digest("e"),
      overrides.operation ?? "read_today",
    ],
  );
}

async function runLifecycleCommand(
  name: "register_trip_agent_group_command" | "activate_trip_agent_command" | "report_trip_agent_announcement_command",
  connectionId: string,
  requestId: string,
  actorDigest: string,
  normalizedRequest: object,
  lifecycleGeneration = 1,
) {
  return db.query<{ result: Record<string, unknown> }>(
    `select ${name}($1,$2,$3,$4,$5,$6,$7) as result`,
    [
      connectionId,
      ids.trip,
      lifecycleGeneration,
      requestId,
      actorDigest,
      normalizedRequest,
      "2026-09-04T12:00:00Z",
    ],
  );
}

describe("trip-agent gateway migration integration", () => {
  it("serializes the public limiter by bucket before counting or recording", async () => {
    const definition = await db.query<{ definition: string }>("select pg_get_functiondef('record_place_lookup(text,integer,integer)'::regprocedure) as definition");
    const body = definition.rows[0].definition;
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body.indexOf("pg_advisory_xact_lock")).toBeLessThan(body.indexOf("select count(*)"));
    const bucket = "sequential-limit-fixture";
    for (let i = 0; i < 3; i++) {
      expect((await db.query<{ allowed: boolean }>("select record_place_lookup($1,3,3600) as allowed", [bucket])).rows[0].allowed).toBe(true);
    }
    expect((await db.query<{ allowed: boolean }>("select record_place_lookup($1,3,3600) as allowed", [bucket])).rows[0].allowed).toBe(false);
  });
  it("keeps longer active windows and sweeps abandoned buckets without waiting on their rows", async () => {
    await db.query("insert into place_lookups(client_hash,created_at) values ('active-hour',now()-interval '2 minutes'),('abandoned',now()-interval '2 days')");
    await db.query("select record_place_lookup('short-window',30,60)");
    expect((await db.query("select client_hash from place_lookups where client_hash in ('active-hour','abandoned') order by client_hash")).rows).toEqual([{ client_hash: "active-hour" }]);
    const definition = await db.query<{ definition: string }>("select pg_get_functiondef('record_place_lookup(text,integer,integer)'::regprocedure) as definition");
    expect(definition.rows[0].definition).toContain("skip locked");
  });
  async function confirmationFixture() {
    const f = await previewForClaim(); const item = await changeFixture('reservation_prepare');
    const request = {kind:'reservation_prepare',itemId:item.itemId,partySize:4,requestedAt:'2026-10-01T18:00:00Z'};
    await db.query("update trip_agent_actions set status='awaiting_confirmation',authority_decision='requires_organizer_confirmation',normalized_request=$2 where id=$1",[f.actionId,request]);
    const confirm = (decision='confirm', actor=ids.traveler, trip=ids.trip) => db.query<{result:{code?:string;action?:{id:string;status:string};attempt?:{id:string;state:string}}}>(
      'select confirm_trip_agent_action($1,$2,$3,$4,$5,$6,null) as result', [f.actionId,trip,actor,decision,digest('f'),item.state]);
    return {...f,...item,request,confirm};
  }
  it("double-confirm creates exactly one private draft and returns one success plus one used conflict", async () => {
    const f=await confirmationFixture(); const results=await Promise.all([f.confirm(),f.confirm()]);
    expect(results.map(r=>r.rows[0].result.action?.status ?? r.rows[0].result.code).sort()).toEqual(['confirmation_used','succeeded']);
    const attempts=(await db.query('select * from reservation_attempts')).rows;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({created_by:ids.traveler,party_size:4,booking_name:'Organizer',contact_email:null,contact_phone:null,alternatives:[],routes:['https://maps.test/museum'],route_index:0,state:'awaiting_approval'});
    expect(JSON.stringify(results)).not.toMatch(/booking_name|contact_|normalized_request|digest|maps.test|Organizer/);
  });
  it.each(['reject','expired'])('persists %s and never creates a draft', async mode => {
    const f=await confirmationFixture();
    if(mode==='expired') await db.query("update trip_agent_actions set confirmation_expires_at=clock_timestamp() where id=$1",[f.actionId]);
    const result=(await f.confirm('reject')).rows[0].result;
    expect(mode==='expired'?result.code:result.action?.status).toBe(mode==='expired'?'confirmation_expired':'rejected');
    expect((await db.query('select status,confirmation_expires_at from trip_agent_actions where id=$1',[f.actionId])).rows).toEqual([{status:mode==='expired'?'expired':'rejected',confirmation_expires_at:null}]);
    expect((await db.query('select id from reservation_attempts')).rows).toHaveLength(0);
  });
  it.each(['wrongTrip','traveler','bot','demoted','scope','paused','policy','item','locked','route','name','unknown','nonReservation'])('refuses confirmation after %s drift', async drift => {
    const f=await confirmationFixture();
    if(drift==='bot') await db.query('update travelers set is_bot=true where id=$1',[ids.traveler]);
    if(drift==='demoted') await db.query('update travelers set is_organizer=false where id=$1',[ids.traveler]);
    if(drift==='scope') await db.query("update trip_agent_connections set granted_scopes='{}' where id=$1",[f.connectionId]);
    if(drift==='paused') await db.query("update trip_agent_connections set status='paused' where id=$1",[f.connectionId]);
    if(drift==='policy') await db.query("update trip_agent_actions set authority_decision='allowed' where id=$1",[f.actionId]);
    if(drift==='item') await db.query('update itinerary_items set day_index=2 where id=$1',[f.itemId]);
    if(drift==='locked') await db.query('update itinerary_items set is_locked=true where id=$1',[f.itemId]);
    if(drift==='route') await db.query("update venue_candidates set maps_url='https://changed.test' where id=$1",[f.venueId]);
    if(drift==='name') await db.query("update travelers set display_name='Changed' where id=$1",[ids.traveler]);
    if(drift==='unknown') await db.query("update trip_agent_actions set status='unknown' where id=$1",[f.actionId]);
    if(drift==='nonReservation') await db.query("update trip_agent_actions set normalized_request='{}' where id=$1",[f.actionId]);
    expect((await f.confirm('confirm',drift==='traveler'?ids.tripTraveler:ids.traveler,drift==='wrongTrip'?ids.otherTrip:ids.trip)).rows[0].result.code).toBeTruthy();
    expect((await db.query('select id from reservation_attempts')).rows).toHaveLength(0);
  });
  it("leaves a conflicting manual active attempt unadopted and the challenge retryable", async () => {
    const f=await confirmationFixture();
    await db.query("insert into reservation_attempts(trip_id,itinerary_item_id,created_by,party_size,requested_at,booking_name,routes) values($1,$2,$3,2,now(),'Manual','[\"https://manual.test\"]')",[ids.trip,f.itemId,ids.traveler]);
    expect((await f.confirm()).rows[0].result).toEqual({code:'reservation_attempt_active'});
    expect((await db.query('select status,canonical_reference from trip_agent_actions where id=$1',[f.actionId])).rows).toEqual([{status:'awaiting_confirmation',canonical_reference:null}]);
    await db.query("update reservation_attempts set state='failed'");
    expect((await f.confirm()).rows[0].result.action?.status).toBe('succeeded');
  });
  it("rolls back the attempt if saving the action fails", async () => {
    const f=await confirmationFixture();
    await db.exec("create function test_confirmation_failure() returns trigger language plpgsql as $$ begin if new.status='succeeded' then raise exception 'injected failure'; end if; return new; end $$; create trigger test_confirmation_failure before update on trip_agent_actions for each row execute function test_confirmation_failure()");
    try {
      await expect(f.confirm()).rejects.toThrow('injected failure');
      expect((await db.query('select id from reservation_attempts')).rows).toHaveLength(0);
      expect((await db.query('select status from trip_agent_actions where id=$1',[f.actionId])).rows).toEqual([{status:'awaiting_confirmation'}]);
    } finally { await db.exec('drop trigger test_confirmation_failure on trip_agent_actions; drop function test_confirmation_failure()'); }
    expect((await f.confirm()).rows[0].result.action?.status).toBe('succeeded');
  });
  async function proposalCommandFixture(operation = "vote", kind = "suggest") {
    const f = await previewForClaim();
    await db.query("update trip_agent_connections set granted_scopes=array['trip.vote','trip.modify','trip.propose'] where id=$1", [f.connectionId]);
    const change = kind === "suggest" ? null : await changeFixture(kind);
    const proposalId = change ? (await change.create()).rows[0].id : (await db.query<{ id: string }>("select create_suggestion_proposal($1,$2,'Museum visit') as id", [ids.trip, ids.traveler])).rows[0].id;
    await db.query("update trip_agent_actions set status='awaiting_vote', proposal_id=$2::uuid, canonical_reference=jsonb_build_object('kind','plan_proposal','id',$2::uuid), external_actor_digest=$3 where id=$1", [f.actionId, proposalId, digest('d')]);
    const commandId = (await insertAction(f.connectionId, { operation, idempotencyKey: 'command' })).rows[0].id;
    await db.query("update trip_agent_actions set mapped_traveler_id=$2, normalized_request=$3 where id=$1", [commandId, ids.traveler, { actionId: f.actionId, ...(operation === 'vote' ? { vote: 'down' } : { decision: 'approve' }) }]);
    const prepare = () => db.query<{ result: { action: { status: string }; proposal?: { id: string } } }>("select prepare_trip_agent_proposal_action($1,$2,$3,$4,$5) as result", [commandId,f.connectionId,ids.trip,digest('e'),digest('b')]);
    const settlement = { status: 'applied', reasonCode: 'approved', yes: 1, no: 0, needed: 2, travelerCount: 3 };
    const settle = () => db.query("select settle_trip_agent_proposal_action($1,$2,$3,$4,$5,$6,$7,$8,'Approved',$9)", [commandId,f.connectionId,ids.trip,digest('e'),digest('b'),proposalId,ids.traveler,operation === 'decide' ? 'approve' : null,settlement]);
    return { ...f, change, proposalId, commandId, prepare, settle, settlement };
  }

  it("resolves another actor's preview, upserts one vote, and claims a separate command once", async () => {
    const f = await proposalCommandFixture();
    expect((await f.prepare()).rows[0].result.proposal?.id).toBe(f.proposalId);
    expect((await db.query('select value from plan_proposal_votes where proposal_id=$1 and traveler_id=$2', [f.proposalId,ids.traveler])).rows).toEqual([{value:-1}]);
    expect((await f.prepare()).rows[0].result).not.toHaveProperty('proposal');
    expect((await db.query('select status from trip_agent_actions where id=$1',[f.actionId])).rows).toEqual([{status:'awaiting_vote'}]);
  });
  it.each(['bot','demoted','revoked','scope','mapping','wrongTarget','wrongTrip','wrongKind','canonical','decided'])('rejects %s at the locked decision preparation boundary', async drift => {
    const f = await proposalCommandFixture('decide');
    if(drift==='bot') await db.query('update travelers set is_bot=true where id=$1',[ids.traveler]);
    if(drift==='demoted') await db.query('update travelers set is_organizer=false where id=$1',[ids.traveler]);
    if(drift==='revoked') await db.query("update trip_agent_connections set status='paused' where id=$1",[f.connectionId]);
    if(drift==='scope') await db.query("update trip_agent_connections set granted_scopes='{}' where id=$1",[f.connectionId]);
    if(drift==='mapping') await db.query("update trip_agent_participant_mappings set status='revoked',revoked_at=now() where connection_id=$1",[f.connectionId]);
    if(drift==='wrongTarget') await db.query("update trip_agent_actions set normalized_request=jsonb_set(normalized_request,'{actionId}',to_jsonb($2::text)) where id=$1",[f.commandId,ids.otherTrip]);
    if(drift==='wrongTrip') await db.query("update trip_agent_actions set normalized_request=jsonb_set(normalized_request,'{actionId}',to_jsonb($2::text)) where id=$1",[f.commandId,(await insertAction(await insertConnection(ids.otherTrip,digest('9')),{tripId:ids.otherTrip})).rows[0].id]);
    if(drift==='wrongKind') await db.query("update trip_agent_actions set operation='vote' where id=$1",[f.actionId]);
    if(drift==='canonical') await db.query("update trip_agent_actions set canonical_reference=null where id=$1",[f.actionId]);
    if(drift==='decided') await db.query("select close_plan_proposal($1,$2,'rejected','Rejected')",[f.proposalId,ids.traveler]);
    await expect(f.prepare()).rejects.toMatchObject({code:drift==='decided'?'TP005':['wrongTarget','wrongTrip','wrongKind','canonical'].includes(drift)?'TP007':'TP006'});
    expect((await db.query('select value from plan_proposal_votes where proposal_id=$1',[f.proposalId])).rows).toEqual([{value:1}]);
  });
  it.each(['bot','demoted','revoked','scope','mapping'])('revalidates %s after prepare and before final apply/close', async drift => {
    const f = await proposalCommandFixture('decide'); await f.prepare();
    if(drift==='bot') await db.query('update travelers set is_bot=true where id=$1',[ids.traveler]);
    if(drift==='demoted') await db.query('update travelers set is_organizer=false where id=$1',[ids.traveler]);
    if(drift==='revoked') await db.query("update trip_agent_connections set status='paused' where id=$1",[f.connectionId]);
    if(drift==='scope') await db.query("update trip_agent_connections set granted_scopes='{}' where id=$1",[f.connectionId]);
    if(drift==='mapping') await db.query("update trip_agent_participant_mappings set status='revoked',revoked_at=now() where connection_id=$1",[f.connectionId]);
    await expect(f.settle()).rejects.toMatchObject({code:'TP006'});
    expect((await db.query('select status from plan_proposals where id=$1',[f.proposalId])).rows).toEqual([{status:'open'}]);
  });
  it("atomically persists the exact settlement and exposes a distinct already-decided outcome", async () => {
    const f = await proposalCommandFixture('decide'); await f.prepare(); await f.settle();
    expect((await db.query<{result:{settlement:unknown}}>('select result from trip_agent_actions where id=$1',[f.commandId])).rows[0].result.settlement).toEqual(f.settlement);
    await expect(f.settle()).rejects.toMatchObject({code:'TP005'});
    expect((await db.query('select id from trip_suggestions')).rows).toHaveLength(1);
  });
  it.each(['vote','join','departure','bot'])('rejects %s drift before a forced gateway settlement mutates anything', async drift => {
    const f = await proposalCommandFixture('decide');
    await f.prepare();
    f.settlement.yes = 1;
    if (drift === 'vote') await db.query('update plan_proposal_votes set value=-1 where proposal_id=$1', [f.proposalId]);
    if (drift === 'join') await db.query("insert into travelers(trip_id,display_name,token,interests,pace,dietary) values($1,'New','joined',array['art'],'balanced','none')",[ids.trip]);
    if (drift === 'departure') await db.query('delete from travelers where id=$1',[ids.alternateTripTraveler]);
    if (drift === 'bot') {
      await db.query('insert into plan_proposal_votes(proposal_id,traveler_id,value) values($1,$2,1)',[f.proposalId,ids.tripTraveler]);
      f.settlement.yes = 2;
      await db.query('update travelers set is_bot=true where id=$1',[ids.tripTraveler]);
    }
    await expect(f.settle()).rejects.toMatchObject({code:'TP008'});
    expect((await db.query('select status from plan_proposals where id=$1',[f.proposalId])).rows).toEqual([{status:'open'}]);
    expect((await db.query('select status,result from trip_agent_actions where id=$1',[f.commandId])).rows).toEqual([{status:'executing',result:null}]);
    expect((await db.query('select id from trip_suggestions')).rows).toHaveLength(0);
  });
  it("rejects impossible verdict pairs and guards legacy open tallies", async () => {
    const f = await proposalCommandFixture('decide');
    const tally = {status:'open',reasonCode:'awaiting_vote',yes:1,no:0,needed:2,travelerCount:3};
    const settle = (value: unknown) => db.query('select settle_plan_proposal_guarded($1,$2,null,$3,$4)',[f.proposalId,ids.traveler,'Waiting',value]);
    await expect(settle({...tally,reasonCode:'approved'})).rejects.toMatchObject({code:'TP008'});
    await expect(settle({...tally,status:'applied',reasonCode:'approved'})).rejects.toMatchObject({code:'TP008'});
    await settle(tally);
    expect((await db.query('select status from plan_proposals where id=$1',[f.proposalId])).rows).toEqual([{status:'open'}]);
  });
  it.each(['lock','slot','occupied','replacement'])('does not force-apply %s drift that occurs after the TypeScript safety read', async drift => {
    const f = await proposalCommandFixture('decide',drift==='replacement'?'replace':'move'); await f.prepare();
    if(drift==='lock') await db.query('update itinerary_items set is_locked=true where id=$1',[f.change!.itemId]);
    if(drift==='slot') await db.query('update itinerary_items set day_index=2 where id=$1',[f.change!.itemId]);
    if(drift==='occupied' || drift==='replacement') await db.query("insert into itinerary_items(trip_id,day_index,block,candidate_id,duration_min) values($1,1,'dinner',$2,60)",[ids.trip,f.change!.replacementId]);
    await expect(f.settle()).rejects.toMatchObject({code:['lock','slot'].includes(drift)?'23514':'23505'});
    expect((await db.query('select status from plan_proposals where id=$1',[f.proposalId])).rows).toEqual([{status:'open'}]);
    expect((await db.query('select status,result from trip_agent_actions where id=$1',[f.commandId])).rows).toEqual([{status:'executing',result:null}]);
  });

  it("rolls back a canonical apply when durable settlement persistence fails", async () => {
    const f = await proposalCommandFixture('decide'); await f.prepare();
    await db.exec("create function test_settlement_failure() returns trigger language plpgsql as $$ begin if new.status='succeeded' then raise exception 'injected failure'; end if; return new; end $$; create trigger test_settlement_failure before update on trip_agent_actions for each row execute function test_settlement_failure()");
    try {
      await expect(f.settle()).rejects.toThrow('injected failure');
      expect((await db.query('select id from trip_suggestions')).rows).toHaveLength(0);
      expect((await db.query('select status from plan_proposals where id=$1',[f.proposalId])).rows).toEqual([{status:'open'}]);
    } finally { await db.exec('drop trigger test_settlement_failure on trip_agent_actions; drop function test_settlement_failure()'); }
  });
  it.each([
    'prepare_trip_agent_proposal_action(uuid,uuid,uuid,text,text)',
    'settle_plan_proposal_guarded(uuid,uuid,text,text,jsonb)',
    'lock_plan_proposal_settlement(uuid)',
    'validate_plan_proposal_settlement(uuid,uuid,text,jsonb)',
    'settle_trip_agent_proposal_action(uuid,uuid,uuid,text,text,uuid,uuid,text,text,jsonb)',
    'confirm_trip_agent_action(uuid,uuid,uuid,text,text,jsonb,text)'
  ])('keeps %s service-role-only', async signature => {
    const result = await db.query<{ anon:boolean;authenticated:boolean;service:boolean }>("select has_function_privilege('anon',$1,'EXECUTE') as anon,has_function_privilege('authenticated',$1,'EXECUTE') as authenticated,has_function_privilege('service_role',$1,'EXECUTE') as service",[signature]);
    expect(result.rows).toEqual([{anon:false,authenticated:false,service:true}]);
  });
  async function changeFixture(kind = "move") {
    const venues = await db.query<{ id: string }>(`insert into venue_candidates (trip_id,place_id,name,category,lat,lng,maps_url)
      values ($1,'museum','Museum','art',1,1,'https://maps.test/museum'), ($1,'gallery','Gallery','art',1,1,'https://maps.test/gallery') returning id`, [ids.trip]);
    const venueId = venues.rows[0].id; const replacementId = venues.rows[1].id;
    const itemId = (await db.query<{ id: string }>(`insert into itinerary_items (trip_id,day_index,block,candidate_id,duration_min)
      values ($1,0,'morning',$2,60) returning id`, [ids.trip, venueId])).rows[0].id;
    const change = { kind, itemId, toDayIndex: 1, toBlock: 'dinner', replacementCandidateId: replacementId };
    const state = (await db.query<{ state: Record<string, unknown> }>("select trip_agent_change_state($1,$2) as state", [ids.trip, change])).rows[0].state;
    const create = () => db.query<{ id: string }>("select create_plan_proposal($1,$2,$3,$4,$5,$6,'',$7,$8) as id",
      [ids.trip, itemId, ids.traveler, kind, kind === 'move' ? 1 : null, kind === 'move' ? 'dinner' : null, kind === 'replace' ? replacementId : null, state]);
    return { itemId, venueId, replacementId, change, state, create };
  }

  it.each(['move', 'remove', 'replace'])("creates a guarded %s with its atomic proposer vote", async kind => {
    const fixture = await changeFixture(kind); const proposalId = (await fixture.create()).rows[0].id;
    expect((await db.query('select value from plan_proposal_votes where proposal_id=$1', [proposalId])).rows).toEqual([{ value: 1 }]);
  });

  it.each(['slot', 'lock', 'reservation', 'candidate', 'venue', 'destination', 'replacement'])("rejects %s drift under the canonical proposal locks", async drift => {
    const f = await changeFixture(drift === 'replacement' ? 'replace' : 'move');
    if (drift === 'slot') await db.query("update itinerary_items set day_index=2 where id=$1", [f.itemId]);
    if (drift === 'lock') await db.query("update itinerary_items set is_locked=true where id=$1", [f.itemId]);
    if (drift === 'reservation') await db.query("update itinerary_items set reservation_status='confirmed', reservation_at=now(), confirmation_number='confirmed-test', is_locked=true where id=$1", [f.itemId]);
    if (drift === 'candidate') await db.query("update itinerary_items set candidate_id=$2 where id=$1", [f.itemId, f.replacementId]);
    if (drift === 'venue') await db.query("update venue_candidates set name='Changed' where id=$1", [f.venueId]);
    if (drift === 'destination' || drift === 'replacement') await db.query(`insert into itinerary_items (trip_id,day_index,block,candidate_id,duration_min) values ($1,1,'dinner',$2,60)`, [ids.trip, f.replacementId]);
    await expect(f.create()).rejects.toMatchObject({ code: ['lock', 'reservation'].includes(drift) ? 'TP002' : ['destination', 'replacement'].includes(drift) ? 'TP003' : 'TP001' });
    expect((await db.query('select id from plan_proposals')).rows).toHaveLength(0);
  });

  it("accepts an unchanged reservation safety state and sets confirmation expiry from database claim time", async () => {
    const { actionId, claim } = await previewForClaim(); const f = await changeFixture('reservation_prepare');
    await db.query("update trip_agent_actions set normalized_request=$2 where id=$1", [actionId, f.change]);
    const before = Date.now(); const result = await claim({ state: f.state }); const after = Date.now();
    expect(result.rows[0].action.status).toBe('executing');
    const expiry = Date.parse(result.rows[0].action.confirmation_expires_at);
    expect(expiry).toBeGreaterThanOrEqual(before + 900_000);
    expect(expiry).toBeLessThanOrEqual(after + 900_000);
    expect((await db.query('select id from reservation_attempts')).rows).toHaveLength(0);
  });

  it.each(['organizerName', 'mapsRoute', 'bookingRoute', 'itemLock'])("refuses changed private reservation %s at claim", async drift => {
    const { actionId, claim } = await previewForClaim(); const f = await changeFixture('reservation_prepare');
    await db.query("update trip_agent_actions set normalized_request=$2 where id=$1", [actionId, f.change]);
    if (drift === 'organizerName') await db.query("update travelers set display_name='Changed private name' where id=$1", [ids.traveler]);
    if (drift === 'mapsRoute') await db.query("update venue_candidates set maps_url='https://changed.test' where id=$1", [f.venueId]);
    if (drift === 'bookingRoute') await db.query("update itinerary_items set booking_url='https://booking.test/private' where id=$1", [f.itemId]);
    if (drift === 'itemLock') await db.query("update itinerary_items set is_locked=true where id=$1", [f.itemId]);
    await expect(claim({ state: f.state })).rejects.toMatchObject({ code: 'TP001' });
    expect((await db.query('select status from trip_agent_actions where id=$1', [actionId])).rows).toEqual([{ status: 'previewed' }]);
  });

  it("claims an ordinary traveler's reservation request using an independently resolved human organizer", async () => {
    const { connectionId, actionId, claim } = await previewForClaim(); const f = await changeFixture('reservation_prepare');
    await db.query("update trip_agent_participant_mappings set traveler_id=$2 where connection_id=$1", [connectionId, ids.tripTraveler]);
    await db.query("update trip_agent_actions set normalized_request=$2, mapped_traveler_id=$3 where id=$1", [actionId, f.change, ids.tripTraveler]);
    expect((await claim({ state: f.state, organizer: false })).rows[0]).toMatchObject({ is_organizer: false, action: { status: 'executing' } });
  });

  it("binds parsed route selection to unchanged private canonical inputs, including malformed booking fallbacks", async () => {
    const { actionId, claim } = await previewForClaim(); const f = await changeFixture('reservation_prepare');
    await db.query("update itinerary_items set booking_url='https://[broken' where id=$1", [f.itemId]);
    await db.query("update travelers set display_name=E'\\t Organizer \\n' where id=$1", [ids.traveler]);
    const route = 'https://maps.test/museum';
    const state = (await db.query<{ state: Record<string, unknown> }>("select trip_agent_change_state($1,$2,$3) as state", [ids.trip, f.change, route])).rows[0].state;
    expect(state.privateReservation).toMatchObject({ route, bookingUrl: 'https://[broken', mapsUrl: route, organizerName: 'Organizer' });
    await db.query("update trip_agent_actions set normalized_request=$2 where id=$1", [actionId, f.change]);
    expect((await claim({ state })).rows[0].action.status).toBe('executing');
  });

  async function previewForClaim() {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query(`update trip_agent_connections set status = 'active', whatsapp_group_digest = $2,
      granted_scopes = array['trip.propose','trip.modify'] where id = $1`, [connectionId, digest("b")]);
    await db.query(`insert into trip_agent_participant_mappings
      (connection_id, external_participant_digest, traveler_id, status, confirmed_by, confirmed_at)
      values ($1, $2, $3, 'confirmed', $3, now())`, [connectionId, digest("e"), ids.traveler]);
    const action = await insertAction(connectionId, { operation: "preview_change" });
    const actionId = action.rows[0].id;
    await db.query(`update trip_agent_actions set status = 'previewed', mapped_traveler_id = $2,
      normalized_request = '{"kind":"suggest","text":"Museum"}', plan_fingerprint = $3,
      confirmation_expires_at = clock_timestamp() + interval '10 minutes' where id = $1`, [actionId, ids.traveler, digest("f")]);
    const claim = (overrides: { at?: string; fingerprint?: string; actor?: string; group?: string; state?: unknown; organizer?: boolean } = {}) => db.query<{ action: { status: string; confirmation_expires_at: string }; is_organizer: boolean; authority_policy: unknown }>(
      `select * from claim_trip_agent_action($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [actionId, connectionId, ids.trip, overrides.actor ?? digest("e"), overrides.group ?? digest("b"), overrides.fingerprint ?? digest("f"), overrides.at ?? "2026-09-04T12:00:00Z", overrides.organizer ?? true, overrides.state ?? { tripId: ids.trip, matchingOpenSuggestions: [] }],
    );
    return { connectionId, actionId, claim };
  }

  it("claims an action at most once and leaves executing/unknown replay unclaimed", async () => {
    const { actionId, claim } = await previewForClaim();
    const results = await Promise.all([claim(), claim()]);
    expect(results.flatMap(result => result.rows)).toEqual([expect.objectContaining({ action: expect.objectContaining({ status: "executing" }), is_organizer: true })]);
    expect((await claim()).rows).toHaveLength(0);
    await db.query("update trip_agent_actions set status = 'unknown' where id = $1", [actionId]);
    expect((await claim()).rows).toHaveLength(0);
  });

  it("refuses mismatched actor/group/fingerprint claims without consuming the preview", async () => {
    const { claim } = await previewForClaim();
    for (const mismatch of [{ actor: digest("a") }, { group: digest("a") }, { fingerprint: digest("a") }]) {
      expect((await claim(mismatch)).rows).toHaveLength(0);
    }
    expect((await claim()).rows).toHaveLength(1);
  });

  it("persists and returns preview_expired when authoritative claim time reaches expiry despite an earlier app clock", async () => {
    const { actionId, claim } = await previewForClaim();
    await db.query("update trip_agent_actions set confirmation_expires_at = clock_timestamp() where id = $1", [actionId]);
    const result = await claim({ at: '2000-01-01T00:00:00Z' });
    expect(result.rows[0].action).toMatchObject({ status: 'expired', error_code: 'preview_expired', confirmation_expires_at: null, result: { status: 'expired' } });
    expect((await db.query('select status,error_code,confirmation_expires_at from trip_agent_actions where id=$1', [actionId])).rows).toEqual([
      { status: 'expired', error_code: 'preview_expired', confirmation_expires_at: null },
    ]);
    expect((await claim()).rows).toHaveLength(0);
    expect((await db.query('select id from plan_proposals')).rows).toHaveLength(0);
  });

  it("keeps claim traveler locks compatible with proposal foreign-key KEY SHARE while guarding role updates", async () => {
    // PGlite has one backend; assert the actual installed lock clauses rather
    // than pretending Promise.all can simulate a PostgreSQL lock deadlock.
    const definition = (await db.query<{ definition: string }>(`select pg_get_functiondef(
      'claim_trip_agent_action(uuid,uuid,uuid,text,text,text,timestamptz,boolean,jsonb)'::regprocedure) as definition`)).rows[0].definition;
    expect(definition).toMatch(/select \* into v_traveler from travelers\s+where[^;]+for no key update;/);
    expect(definition).toMatch(/perform 1 from travelers t[^;]+for no key update;/);
    expect(definition).not.toMatch(/from travelers(?: t)?\s+where[^;]+for update;/);
  });

  it("physically locks trip, ordered travelers, proposal and ordered votes for every finalizer", async () => {
    // PGlite has one backend. This checks the installed lock contract, not a
    // simulated contention test: legacy apply owns the proposal before its
    // trip_suggestions insert requests trip/traveler FK KEY SHARE locks.
    const definition = (await db.query<{ definition: string }>(`select pg_get_functiondef(
      'lock_trip_agent_proposal_action(uuid,uuid,uuid,text,text,text)'::regprocedure) as definition`)).rows[0].definition;
    expect(definition).toContain('lock_plan_proposal_settlement(v_target.proposal_id)');
    expect(definition).toMatch(/from travelers where[^;]+for no key update;/);
    const shared = (await db.query<{definition:string}>("select pg_get_functiondef('lock_plan_proposal_settlement(uuid)'::regprocedure) as definition")).rows[0].definition;
    expect(shared).toContain('from trips where id=v_trip_id for update');
    expect(shared).toContain('for v_id in select id from travelers where trip_id=v_trip_id order by id loop');
    expect(shared).toContain('for v_id in select traveler_id from plan_proposal_votes where proposal_id=p_proposal_id order by traveler_id loop');
    expect(shared.indexOf('from trips')).toBeLessThan(shared.indexOf('for v_id'));
    expect(shared.indexOf('for no key update')).toBeLessThan(shared.indexOf('select * into v_proposal'));
    expect(shared.indexOf('select * into v_proposal')).toBeLessThan(shared.indexOf('order by traveler_id loop'));

    const legacy = (await db.query<{ definition: string }>(`select pg_get_functiondef(
      'apply_plan_proposal(uuid,uuid,text)'::regprocedure) as definition`)).rows[0].definition;
    expect(legacy).toContain('lock_plan_proposal_settlement(p_proposal_id)');
    expect(legacy).toMatch(/insert into trip_suggestions \(trip_id, traveler_id, text\)/);
    const creation = (await db.query<{ definition: string }>(`select pg_get_functiondef(
      'create_plan_proposal(uuid,uuid,uuid,text,integer,text,text,uuid)'::regprocedure) as definition`)).rows[0].definition;
    expect(creation.search(/from trips where[^;]+for update;/)).toBeLessThan(creation.search(/update plan_proposals/));
  });
  it("takes a trip lock before traveler locks in gateway paths that later need trip FK locks", async () => {
    const rows = (await db.query<{definition:string}>(`select pg_get_functiondef(oid) as definition from pg_proc where proname in
      ('claim_trip_agent_action','rotate_trip_agent_credential','replace_trip_agent_connection','activate_trip_agent_connection','transition_trip_agent_participant_mapping')`)).rows;
    for (const {definition} of rows) {
      const travelerLock = definition.search(/from travelers[^;]+for (?:no key )?update;/);
      expect(definition.search(/from trips[^;]+for update;/), definition).toBeGreaterThan(-1);
      expect(definition.search(/from trips[^;]+for update;/), definition).toBeLessThan(travelerLock);
    }
  });

  it.each([
    'prepare_trip_agent_proposal_action(uuid,uuid,uuid,text,text)',
    'settle_trip_agent_proposal_action(uuid,uuid,uuid,text,text,uuid,uuid,text,text,jsonb)',
  ])("uses the compatible shared guard without upgrading the trip lock in %s", async signature => {
    const definition = (await db.query<{ definition: string }>('select pg_get_functiondef($1::regprocedure) as definition', [signature])).rows[0].definition;
    expect(definition).toContain('lock_trip_agent_proposal_action(');
    expect(definition).not.toMatch(/from trips\s+where[^;]+for update;/);
  });

  it("finalizes previews once using database time, and refuses to overwrite the winner", async () => {
    const connectionId = await insertConnection();
    const actionId = (await insertAction(connectionId)).rows[0].id;
    const result = await db.query<{ confirmation_expires_at: Date; updated_at: Date; preview: { expiresAt: string } }>(
      "select * from finalize_trip_agent_preview($1,$2,$3,$4,'previewed',$5,$6,null)",
      [actionId, connectionId, ids.trip, digest('e'), { impact: 'Museum', expiresAt: '1900-01-01T00:00:00Z' }, digest('f')]);
    const row = result.rows[0];
    expect(row.confirmation_expires_at.getTime() - row.updated_at.getTime()).toBe(600_000);
    expect(Date.parse(row.preview.expiresAt)).toBe(row.confirmation_expires_at.getTime());
    expect((await db.query("select * from finalize_trip_agent_preview($1,$2,$3,$4,'failed',null,null,'database_unavailable')", [actionId, connectionId, ids.trip, digest('e')])).rows).toHaveLength(0);
  });

  it("locks the connection generation before finalizing an in-flight preview", async () => {
    // PGlite has one backend, so verify the installed lock contract that makes
    // replacement and preview finalization serialize on the connection row.
    const definition = (await db.query<{ definition: string }>(`select pg_get_functiondef(
      'finalize_trip_agent_preview(uuid,uuid,uuid,text,text,jsonb,text,text)'::regprocedure) as definition`)).rows[0].definition;
    const connectionLock = /from trip_agent_connections\s+where[^;]+for update;/;
    const actionLock = /from trip_agent_actions\s+where[^;]+for update;/;

    expect(definition).toMatch(connectionLock);
    expect(definition.search(connectionLock)).toBeLessThan(definition.search(actionLock));
  });

  it("nulls only deleted reference columns while retaining the action trip", async () => {
    const { actionId } = await previewForClaim();
    const proposal = await db.query<{ id: string }>("select create_suggestion_proposal($1,$2,'Museum') as id", [ids.trip, ids.traveler]);
    await db.query("update trip_agent_actions set proposal_id=$2 where id=$1", [actionId, proposal.rows[0].id]);
    await db.query("delete from plan_proposals where id=$1", [proposal.rows[0].id]);
    await db.query("delete from travelers where id=$1", [ids.traveler]);
    expect((await db.query("select trip_id, mapped_traveler_id, proposal_id from trip_agent_actions where id=$1", [actionId])).rows).toEqual([{ trip_id: ids.trip, mapped_traveler_id: null, proposal_id: null }]);
  });

  it("checks normalized duplicate suggestions under the proposal creation lock with one atomic yes vote", async () => {
    const expected = { tripId: ids.trip, matchingOpenSuggestions: [] };
    const proposal = await db.query<{ id: string }>("select create_suggestion_proposal($1,$2,'Try  Museum',$3) as id", [ids.trip, ids.traveler, expected]);
    await expect(db.query("select create_suggestion_proposal($1,$2,' try museum ',$3)", [ids.trip, ids.traveler, expected])).rejects.toMatchObject({ code: 'TP004' });
    expect((await db.query("select value from plan_proposal_votes where proposal_id=$1", [proposal.rows[0].id])).rows).toEqual([{ value: 1 }]);
  });

  it.each(["revoked", "remapped", "bot", "role", "scope", "policy", "paused"])("refuses a claim when current %s authorization changed", async change => {
    const { connectionId, claim } = await previewForClaim();
    if (change === "revoked") await db.query("update trip_agent_participant_mappings set status = 'revoked', revoked_at = now() where connection_id = $1", [connectionId]);
    if (change === "remapped") await db.query("update trip_agent_participant_mappings set traveler_id = $2 where connection_id = $1", [connectionId, ids.tripTraveler]);
    if (change === "bot") await db.query("update travelers set is_bot = true where id = $1", [ids.traveler]);
    if (change === "role" || change === "policy") await db.query("update travelers set is_organizer = false where id = $1", [ids.traveler]);
    if (change === "policy") await db.query(`update trip_agent_connections set authority_policy = '{"travelerCanAddSuggestion":false,"travelerCanProposeChange":false}' where id = $1`, [connectionId]);
    if (change === "scope") await db.query("update trip_agent_connections set granted_scopes = array[]::text[] where id = $1", [connectionId]);
    if (change === "paused") await db.query("update trip_agent_connections set status = 'paused' where id = $1", [connectionId]);
    expect((await claim()).rows).toHaveLength(0);
  });

  it("enforces same-trip action traveler and proposal references", async () => {
    const { actionId } = await previewForClaim();
    await expect(db.query("update trip_agent_actions set mapped_traveler_id = $2 where id = $1", [actionId, ids.otherTraveler])).rejects.toThrow(/foreign key/i);
    const proposal = await db.query<{ id: string }>(`insert into plan_proposals (trip_id, proposed_by, kind, suggestion_text)
      values ($1, $2, 'suggest', 'Museum') returning id`, [ids.otherTrip, ids.otherTraveler]);
    await expect(db.query("update trip_agent_actions set proposal_id = $2 where id = $1", [actionId, proposal.rows[0].id])).rejects.toThrow(/foreign key/i);
  });
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await applyMigrations(db);
  }, 120_000);

  beforeEach(async () => {
    await db.exec("truncate table trip_agent_connections, travelers, trips cascade");
    await seedTripsAndTravelers();
  });

  afterAll(async () => {
    await db.close();
  });

  it("allows only one connector per trip and defaults it to setup-only pending access", async () => {
    const connectionId = await insertConnection();
    const connection = await db.query<{
      status: string;
      granted_scopes: string[];
      authority_policy: Record<string, boolean>;
    }>(
      `select status, granted_scopes, authority_policy
       from trip_agent_connections where id = $1`,
      [connectionId],
    );

    expect(connection.rows[0]).toEqual({
      status: "pending",
      granted_scopes: ["connector.setup"],
      authority_policy: {
        travelerCanAddSuggestion: true,
        travelerCanProposeChange: true,
      },
    });
    await expect(insertConnection(ids.trip, digest("b"), "hermes")).rejects.toThrow(/unique/i);
    await expect(insertConnection(ids.otherTrip, digest("b"), "unsupported")).rejects.toThrow(/check/i);
  });

  it("starts every connection at positive lifecycle generation one", async () => {
    const connectionId = await insertConnection();

    expect((await db.query("select lifecycle_generation from trip_agent_connections where id=$1", [connectionId])).rows)
      .toEqual([{ lifecycle_generation: 1 }]);
    await expect(db.query("update trip_agent_connections set lifecycle_generation=0 where id=$1", [connectionId]))
      .rejects.toThrow(/check/i);
  });

  it.each(["revoked", "archived"])("replaces a %s connector with a fresh identity and idempotency generation while retaining audit history", async terminalStatus => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query(`update trip_agent_connections set status='active', whatsapp_group_digest=$2,
      whatsapp_group_label='Old group', granted_scopes=array['connector.setup','trip.read'] where id=$1`, [connectionId, digest("b")]);
    const oldMapping = await db.query<{ id: string; updated_at: Date }>(`insert into trip_agent_participant_mappings
      (connection_id,lifecycle_generation,external_participant_digest,traveler_id,status,confirmed_by,confirmed_at)
      values($1,1,$2,$3,'confirmed',$3,now()) returning id,updated_at`, [connectionId, digest("e"), ids.traveler]);
    const oldAction = await db.query<{ id: string }>(`insert into trip_agent_actions
      (connection_id,trip_id,lifecycle_generation,idempotency_key,external_actor_digest,operation,normalized_request,authority_decision)
      values($1,$2,1,'same-request',$3,'read_today','{}','allowed') returning id`, [connectionId, ids.trip, digest("e")]);
    await db.query(`update trip_agent_connections set status=$2,credential_digest=null,
      ${terminalStatus === "revoked" ? "revoked_at" : "archived_at"}=now(),updated_at=clock_timestamp()+interval '1 second' where id=$1`, [connectionId, terminalStatus]);
    const before = (await db.query<{ updated_at: Date }>("select updated_at from trip_agent_connections where id=$1", [connectionId])).rows[0];

    const replaced = await db.query<{ lifecycle_generation: number; status: string }>(
      "select lifecycle_generation,status from replace_trip_agent_connection($1,$2,'hermes',$3,$4,$5,$6)",
      [connectionId, before.updated_at, digest("f"), "2026-09-04T12:10:00Z", ids.traveler, "2026-09-04T12:00:00Z"],
    );

    expect(replaced.rows).toEqual([{ lifecycle_generation: 2, status: "pending" }]);
    expect((await db.query(`select lifecycle_generation,status,credential_digest,whatsapp_group_digest,
      privacy_notice_version,activated_at from trip_agent_connections where id=$1`, [connectionId])).rows)
      .toEqual([{ lifecycle_generation: 2, status: "pending", credential_digest: null,
        whatsapp_group_digest: null, privacy_notice_version: null, activated_at: null }]);
    expect((await db.query("select id,lifecycle_generation from trip_agent_participant_mappings where connection_id=$1", [connectionId])).rows)
      .toEqual([{ id: oldMapping.rows[0].id, lifecycle_generation: 1 }]);
    expect((await db.query("select id,lifecycle_generation from trip_agent_actions where connection_id=$1", [connectionId])).rows)
      .toEqual([{ id: oldAction.rows[0].id, lifecycle_generation: 1 }]);

    await db.query("select * from consume_trip_agent_pairing($1,'hermes',$2,$3)", [digest("f"), digest("9"), "2026-09-04T12:01:00Z"]);
    await db.query("update trip_agent_connections set whatsapp_group_digest=$2,whatsapp_group_label='Fresh group' where id=$1", [connectionId, digest("a")]);
    expect((await db.query("select * from activate_trip_agent_connection($1,$2,'v1',$3,$4)",
      [connectionId, digest("a"), digest("d"), "2026-09-04T12:02:00Z"])).rows).toHaveLength(0);
    expect((await transitionMapping({ connectionId, lifecycleGeneration: 2, mappingId: oldMapping.rows[0].id,
      action: "revoke", expectedUpdatedAt: oldMapping.rows[0].updated_at,
      expectedStatus: "confirmed", expectedTravelerId: ids.traveler })).rows).toHaveLength(0);

    await db.query(`insert into trip_agent_participant_mappings
      (connection_id,lifecycle_generation,external_participant_digest,traveler_id,status,confirmed_by,confirmed_at)
      values($1,2,$2,$3,'confirmed',$3,now())`, [connectionId, digest("1"), ids.traveler]);
    expect((await db.query("select * from activate_trip_agent_connection($1,$2,'v1',$3,$4)",
      [connectionId, digest("a"), digest("d"), "2026-09-04T12:03:00Z"])).rows).toHaveLength(1);
    const freshAction = await db.query(`insert into trip_agent_actions
      (connection_id,trip_id,lifecycle_generation,idempotency_key,external_actor_digest,operation,normalized_request,authority_decision)
      values($1,$2,2,'same-request',$3,'read_today','{}','allowed') returning id`, [connectionId, ids.trip, digest("1")]);
    expect(freshAction.rows).toHaveLength(1);
  });

  it("rejects a stale action result write after replacement without mutating history", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const actionId = (await insertAction(connectionId)).rows[0].id;
    await db.query("update trip_agent_connections set status='revoked',credential_digest=null,revoked_at=now(),updated_at=clock_timestamp()+interval '1 second' where id=$1", [connectionId]);
    const terminal = (await db.query<{ updated_at: Date }>("select updated_at from trip_agent_connections where id=$1", [connectionId])).rows[0];
    await db.query("select * from replace_trip_agent_connection($1,$2,'hermes',$3,$4,$5,$6)", [
      connectionId, terminal.updated_at, digest("f"), "2026-09-04T12:10:00Z", ids.traveler, "2026-09-04T12:00:00Z",
    ]);

    const staleWrite = await db.query(
      "select * from write_trip_agent_action_state($1,$2,1,$3,$4,'received',$5)",
      [connectionId, ids.trip, actionId, digest("e"), { status: "failed", error_code: "plan_changed", updated_at: "2026-09-04T12:01:00Z" }],
    );

    expect(staleWrite.rows).toEqual([]);
    expect((await db.query("select status,error_code,lifecycle_generation from trip_agent_actions where id=$1", [actionId])).rows)
      .toEqual([{ status: "received", error_code: null, lifecycle_generation: 1 }]);
  });

  it("replays one atomic group registration and rejects mismatched request reuse", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const requestId = "70000000-0000-4000-8000-000000000001";
    const actorDigest = digest("b");
    const normalized = {
      groupDigest: actorDigest,
      groupLabel: "Family trip",
      participants: [{ digest: digest("e"), displayNameHint: "Sam" }],
    };

    const first = await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId, actorDigest, normalized);
    const replay = await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId, actorDigest, normalized);
    const labelConflict = await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId, actorDigest, {
      ...normalized,
      groupLabel: "Another group",
    });
    const participantConflict = await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId, actorDigest, {
      ...normalized,
      participants: [],
    });

    expect(first.rows[0].result).toEqual({ groupRegistered: true, participantCount: 1 });
    expect(replay.rows[0].result).toEqual(first.rows[0].result);
    expect(labelConflict.rows[0].result).toEqual({ code: "idempotency_conflict" });
    expect(participantConflict.rows[0].result).toEqual({ code: "idempotency_conflict" });
    expect((await db.query("select count(*)::integer as count from trip_agent_actions where connection_id=$1 and operation='register_group'", [connectionId])).rows)
      .toEqual([{ count: 1 }]);
    expect((await db.query("select count(*)::integer as count from trip_agent_participant_mappings where connection_id=$1", [connectionId])).rows)
      .toEqual([{ count: 1 }]);
    expect((await db.query("select status,traveler_id from trip_agent_participant_mappings where connection_id=$1", [connectionId])).rows)
      .toEqual([{ status: "suggested", traveler_id: null }]);
    expect((await db.query("select whatsapp_group_label from trip_agent_connections where id=$1", [connectionId])).rows)
      .toEqual([{ whatsapp_group_label: "Family trip" }]);
  });

  it("replays registration after activation but refuses a fresh registration command", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const requestId = "70000000-0000-4000-8000-000000000011";
    const normalized = { groupDigest: digest("b"), groupLabel: "Family trip", participants: [] };
    const first = await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId, digest("b"), normalized);
    await db.query("update trip_agent_connections set status='active',activated_at=$2 where id=$1", [connectionId, "2026-09-04T12:00:00Z"]);

    const replay = await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId, digest("b"), normalized);
    const fresh = await runLifecycleCommand("register_trip_agent_group_command", connectionId, "70000000-0000-4000-8000-000000000012", digest("b"), normalized);

    expect(replay.rows[0].result).toEqual(first.rows[0].result);
    expect(fresh.rows[0].result).toEqual({ code: "authority_changed" });
    expect((await db.query("select count(*)::integer as count from trip_agent_actions where connection_id=$1 and operation='register_group'", [connectionId])).rows)
      .toEqual([{ count: 1 }]);
  });

  it("canonicalizes registration participant order and request UUID casing for replay", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const requestId = "7A000000-0000-4000-8000-000000000013";
    const firstRequest = {
      groupDigest: digest("b"), groupLabel: "Family trip",
      participants: [{ digest: digest("f"), displayNameHint: "Zed" }, { digest: digest("d"), displayNameHint: "Amy" }],
    };
    const reordered = { ...firstRequest, participants: [...firstRequest.participants].reverse() };

    const first = await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId, digest("b"), firstRequest);
    const replay = await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId.toLowerCase(), digest("b"), reordered);

    expect(replay.rows[0].result).toEqual(first.rows[0].result);
    const stored = await db.query<{ idempotency_key: string; normalized_request: { participants: Array<{ digest: string }> } }>(
      "select idempotency_key,normalized_request from trip_agent_actions where connection_id=$1 and operation='register_group'",
      [connectionId],
    );
    expect(stored.rows[0].idempotency_key).toBe(requestId.toLowerCase());
    expect(stored.rows[0].normalized_request.participants.map((participant) => participant.digest))
      .toEqual([digest("d"), digest("f")]);
  });

  it("refuses a registration replay when its current group authority has changed", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const requestId = "70000000-0000-4000-8000-000000000019";
    const normalized = { groupDigest: digest("b"), groupLabel: "Family trip", participants: [] };
    await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId, digest("b"), normalized);
    await db.query("update trip_agent_connections set whatsapp_group_digest=$2 where id=$1", [connectionId, digest("f")]);

    const replay = await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId, digest("b"), normalized);

    expect(replay.rows[0].result).toEqual({ code: "authority_changed" });
  });

  it("replays the bounded registration refusal when the conflicting group is unchanged", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query("update trip_agent_connections set whatsapp_group_digest=$2,whatsapp_group_label='Existing group' where id=$1", [connectionId, digest("f")]);
    const requestId = "70000000-0000-4000-8000-000000000022";
    const normalized = { groupDigest: digest("b"), groupLabel: "Other group", participants: [] };

    const first = await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId, digest("b"), normalized);
    const replay = await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId, digest("b"), normalized);

    expect(first.rows[0].result).toEqual({ code: "group_mismatch" });
    expect(replay.rows[0].result).toEqual(first.rows[0].result);
  });

  it("rolls back group binding and command state when participant mapping persistence fails", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.exec(`create function fail_test_trip_agent_mapping() returns trigger language plpgsql as $$
      begin raise exception 'injected mapping failure'; end; $$;
      create trigger fail_test_trip_agent_mapping before insert on trip_agent_participant_mappings
      for each row execute function fail_test_trip_agent_mapping();`);
    try {
      await expect(runLifecycleCommand(
        "register_trip_agent_group_command",
        connectionId,
        "70000000-0000-4000-8000-000000000002",
        digest("b"),
        { groupDigest: digest("b"), groupLabel: "Family trip", participants: [{ digest: digest("e"), displayNameHint: "Sam" }] },
      )).rejects.toThrow(/injected mapping failure/i);
    } finally {
      await db.exec("drop trigger fail_test_trip_agent_mapping on trip_agent_participant_mappings; drop function fail_test_trip_agent_mapping();");
    }

    expect((await db.query("select whatsapp_group_digest,whatsapp_group_label from trip_agent_connections where id=$1", [connectionId])).rows)
      .toEqual([{ whatsapp_group_digest: null, whatsapp_group_label: null }]);
    expect((await db.query("select count(*)::integer as count from trip_agent_actions where connection_id=$1", [connectionId])).rows)
      .toEqual([{ count: 0 }]);
  });

  it("replays activation success after the connection is active without a second transition", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query("update trip_agent_connections set whatsapp_group_digest=$2,whatsapp_group_label='Family trip' where id=$1", [connectionId, digest("b")]);
    await db.query(`insert into trip_agent_participant_mappings
      (connection_id,lifecycle_generation,external_participant_digest,traveler_id,status,confirmed_by,confirmed_at)
      values($1,1,$2,$3,'confirmed',$3,now())`, [connectionId, digest("e"), ids.traveler]);
    const normalized = { groupDigest: digest("b"), privacyNoticeVersion: "v1", receiptDigest: digest("d") };
    const requestId = "70000000-0000-4000-8000-000000000003";

    const first = await runLifecycleCommand("activate_trip_agent_command", connectionId, requestId, digest("b"), normalized);
    const replay = await runLifecycleCommand("activate_trip_agent_command", connectionId, requestId, digest("b"), normalized);
    const conflict = await runLifecycleCommand("activate_trip_agent_command", connectionId, requestId, digest("b"), {
      ...normalized,
      receiptDigest: digest("f"),
    });

    expect(first.rows[0].result).toEqual({ status: "active", activatedAt: "2026-09-04T12:00:00.000Z" });
    expect(replay.rows[0].result).toEqual(first.rows[0].result);
    expect(conflict.rows[0].result).toEqual({ code: "idempotency_conflict" });
    expect((await db.query("select status,privacy_notice_version from trip_agent_connections where id=$1", [connectionId])).rows)
      .toEqual([{ status: "active", privacy_notice_version: "v1" }]);
    expect((await db.query("select count(*)::integer as count from trip_agent_actions where connection_id=$1 and operation='activate'", [connectionId])).rows)
      .toEqual([{ count: 1 }]);

    const fresh = await runLifecycleCommand("activate_trip_agent_command", connectionId, "70000000-0000-4000-8000-000000000014", digest("b"), normalized);
    expect(fresh.rows[0].result).toEqual({ code: "authority_changed" });
    expect((await db.query("select count(*)::integer as count from trip_agent_actions where connection_id=$1 and operation='activate'", [connectionId])).rows)
      .toEqual([{ count: 1 }]);
  });

  it("refuses an activation replay after the confirmed human organizer authority is removed", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query("update trip_agent_connections set whatsapp_group_digest=$2,whatsapp_group_label='Family trip' where id=$1", [connectionId, digest("b")]);
    await db.query(`insert into trip_agent_participant_mappings
      (connection_id,lifecycle_generation,external_participant_digest,traveler_id,status,confirmed_by,confirmed_at)
      values($1,1,$2,$3,'confirmed',$3,now())`, [connectionId, digest("e"), ids.traveler]);
    const requestId = "70000000-0000-4000-8000-000000000018";
    const normalized = { groupDigest: digest("b"), privacyNoticeVersion: "v1", receiptDigest: digest("d") };
    await runLifecycleCommand("activate_trip_agent_command", connectionId, requestId, digest("b"), normalized);
    await db.query("update travelers set is_organizer=false where id=$1", [ids.traveler]);

    const replay = await runLifecycleCommand("activate_trip_agent_command", connectionId, requestId, digest("b"), normalized);

    expect(replay.rows[0].result).toEqual({ code: "authority_changed" });
  });

  it("synthesizes bounded replay results instead of echoing stored command JSON", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const requestId = "70000000-0000-4000-8000-000000000015";
    const normalized = { groupDigest: digest("b"), groupLabel: "Family trip", participants: [] };
    await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId, digest("b"), normalized);
    await db.query("update trip_agent_actions set result=$2 where connection_id=$1 and idempotency_key=$3", [
      connectionId, { groupRegistered: true, participantCount: 999, private: "must-not-escape" }, requestId,
    ]);

    const replay = await runLifecycleCommand("register_trip_agent_group_command", connectionId, requestId, digest("b"), normalized);

    expect(replay.rows[0].result).toEqual({ groupRegistered: true, participantCount: 0 });
    expect(JSON.stringify(replay.rows[0].result)).not.toContain("must-not-escape");
  });

  it("rejects non-string lifecycle command scalars before any command is stored", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const activation = await runLifecycleCommand(
      "activate_trip_agent_command", connectionId, "70000000-0000-4000-8000-000000000016", digest("b"),
      { groupDigest: 3, privacyNoticeVersion: "v1", receiptDigest: digest("d") },
    );
    const announcement = await runLifecycleCommand(
      "report_trip_agent_announcement_command", connectionId, "70000000-0000-4000-8000-000000000017", digest("b"),
      { actionId: true, deliveryStatus: "delivered", providerMessageDigest: null },
    );

    expect(activation.rows[0].result).toEqual({ code: "invalid_input" });
    expect(announcement.rows[0].result).toEqual({ code: "invalid_input" });
    expect((await db.query("select count(*)::integer as count from trip_agent_actions where connection_id=$1", [connectionId])).rows)
      .toEqual([{ count: 0 }]);
  });

  it("records one announcement command and refuses a conflicting receipt without rewriting delivery truth", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query("update trip_agent_connections set status='active',whatsapp_group_digest=$2,whatsapp_group_label='Family trip',granted_scopes=array['connector.setup','announcement.write'] where id=$1", [connectionId, digest("b")]);
    const actionId = (await insertAction(connectionId)).rows[0].id;
    await db.query("update trip_agent_actions set status='succeeded',result='{\"status\":\"succeeded\"}' where id=$1", [actionId]);
    const requestId = "70000000-0000-4000-8000-000000000004";
    const normalized = { actionId, deliveryStatus: "delivered", providerMessageDigest: digest("d") };

    const first = await runLifecycleCommand("report_trip_agent_announcement_command", connectionId, requestId, digest("b"), normalized);
    const replay = await runLifecycleCommand("report_trip_agent_announcement_command", connectionId, requestId, digest("b"), normalized);
    const messageConflict = await runLifecycleCommand("report_trip_agent_announcement_command", connectionId, requestId, digest("b"), {
      ...normalized,
      providerMessageDigest: digest("f"),
    });
    const statusConflict = await runLifecycleCommand("report_trip_agent_announcement_command", connectionId, requestId, digest("b"), {
      ...normalized,
      deliveryStatus: "failed",
    });
    const otherActionId = (await insertAction(connectionId, { idempotencyKey: "other-target" })).rows[0].id;
    await db.query("update trip_agent_actions set status='succeeded',result='{\"status\":\"succeeded\"}' where id=$1", [otherActionId]);
    const targetConflict = await runLifecycleCommand("report_trip_agent_announcement_command", connectionId, requestId, digest("b"), {
      ...normalized,
      actionId: otherActionId,
    });

    expect(first.rows[0].result).toEqual({ deliveryStatus: "delivered" });
    expect(replay.rows[0].result).toEqual(first.rows[0].result);
    expect(messageConflict.rows[0].result).toEqual({ code: "idempotency_conflict" });
    expect(statusConflict.rows[0].result).toEqual({ code: "idempotency_conflict" });
    expect(targetConflict.rows[0].result).toEqual({ code: "idempotency_conflict" });
    expect((await db.query("select announcement_status,result#>>'{announcement,providerMessageDigest}' as message_digest from trip_agent_actions where id=$1", [actionId])).rows)
      .toEqual([{ announcement_status: "delivered", message_digest: digest("d") }]);
    expect((await db.query("select announcement_status from trip_agent_actions where id=$1", [otherActionId])).rows)
      .toEqual([{ announcement_status: "pending" }]);

    await db.query("update trip_agent_actions set result=jsonb_set(result,'{announcement,providerMessageDigest}',to_jsonb($2::text)) where id=$1", [actionId, digest("f")]);
    const changedTargetReplay = await runLifecycleCommand("report_trip_agent_announcement_command", connectionId, requestId, digest("b"), normalized);
    expect(changedTargetReplay.rows[0].result).toEqual({ code: "announcement_conflict" });
  });

  it("serializes conflicting announcement commands without overwriting the winning delivery truth", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query("update trip_agent_connections set status='active',whatsapp_group_digest=$2,whatsapp_group_label='Family trip',granted_scopes=array['connector.setup','announcement.write'] where id=$1", [connectionId, digest("b")]);
    const actionId = (await insertAction(connectionId)).rows[0].id;
    await db.query("update trip_agent_actions set status='succeeded',result='{\"status\":\"succeeded\"}' where id=$1", [actionId]);

    const [delivered, failed] = await Promise.all([
      runLifecycleCommand("report_trip_agent_announcement_command", connectionId, "70000000-0000-4000-8000-000000000020", digest("b"), {
        actionId, deliveryStatus: "delivered", providerMessageDigest: digest("d"),
      }),
      runLifecycleCommand("report_trip_agent_announcement_command", connectionId, "70000000-0000-4000-8000-000000000021", digest("b"), {
        actionId, deliveryStatus: "failed", providerMessageDigest: digest("f"),
      }),
    ]);

    const outcomes = [delivered.rows[0].result, failed.rows[0].result];
    expect(outcomes).toContainEqual({ deliveryStatus: "delivered" });
    expect(outcomes).toContainEqual({ code: "announcement_conflict" });
    expect((await db.query("select announcement_status,result#>>'{announcement,providerMessageDigest}' as message_digest from trip_agent_actions where id=$1", [actionId])).rows)
      .toEqual([{ announcement_status: "delivered", message_digest: digest("d") }]);
  });

  it("does not let prior-generation setup or announcement commands mutate retained history", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const registration = { groupDigest: digest("b"), groupLabel: "Old group", participants: [] };
    await runLifecycleCommand("register_trip_agent_group_command", connectionId, "70000000-0000-4000-8000-000000000005", digest("b"), registration);
    const targetId = (await insertAction(connectionId, { idempotencyKey: "old-target" })).rows[0].id;
    await db.query("update trip_agent_actions set status='succeeded' where id=$1", [targetId]);
    await db.query("update trip_agent_connections set status='revoked',credential_digest=null,revoked_at=now(),updated_at=clock_timestamp()+interval '1 second' where id=$1", [connectionId]);
    const terminal = (await db.query<{ updated_at: Date }>("select updated_at from trip_agent_connections where id=$1", [connectionId])).rows[0];
    await db.query("select * from replace_trip_agent_connection($1,$2,'hermes',$3,$4,$5,$6)", [connectionId, terminal.updated_at, digest("f"), "2026-09-04T12:10:00Z", ids.traveler, "2026-09-04T12:00:00Z"]);

    const registrationReplay = await runLifecycleCommand("register_trip_agent_group_command", connectionId, "70000000-0000-4000-8000-000000000005", digest("b"), registration, 1);
    const activation = await runLifecycleCommand("activate_trip_agent_command", connectionId, "70000000-0000-4000-8000-000000000006", digest("b"), { groupDigest: digest("b"), privacyNoticeVersion: "v1", receiptDigest: digest("d") }, 1);
    const announcement = await runLifecycleCommand("report_trip_agent_announcement_command", connectionId, "70000000-0000-4000-8000-000000000007", digest("b"), { actionId: targetId, deliveryStatus: "delivered", providerMessageDigest: null }, 1);

    expect(registrationReplay.rows[0].result).toEqual({ code: "connection_changed" });
    expect(activation.rows[0].result).toEqual({ code: "connection_changed" });
    expect(announcement.rows[0].result).toEqual({ code: "connection_changed" });
    expect((await db.query("select announcement_status,lifecycle_generation from trip_agent_actions where id=$1", [targetId])).rows)
      .toEqual([{ announcement_status: "pending", lifecycle_generation: 1 }]);
    expect((await db.query("select count(*)::integer as count from trip_agent_participant_mappings where connection_id=$1 and lifecycle_generation=2", [connectionId])).rows)
      .toEqual([{ count: 0 }]);
  });

  it("revalidates current registration, activation, and announcement authority inside their transactions", async () => {
    const registrationConnection = await insertConnection();
    await pairConnection(registrationConnection);
    await db.query("update trip_agent_connections set granted_scopes='{}' where id=$1", [registrationConnection]);
    const registration = await runLifecycleCommand(
      "register_trip_agent_group_command",
      registrationConnection,
      "70000000-0000-4000-8000-000000000008",
      digest("b"),
      { groupDigest: digest("b"), groupLabel: "Family trip", participants: [] },
    );
    expect(registration.rows[0].result).toEqual({ code: "authority_changed" });

    await db.exec("truncate table trip_agent_connections cascade");
    const activationConnection = await insertConnection();
    await pairConnection(activationConnection);
    await db.query("update trip_agent_connections set whatsapp_group_digest=$2,whatsapp_group_label='Family trip' where id=$1", [activationConnection, digest("b")]);
    await db.query(`insert into trip_agent_participant_mappings
      (connection_id,lifecycle_generation,external_participant_digest,traveler_id,status,confirmed_by,confirmed_at)
      values($1,1,$2,$3,'confirmed',$3,now())`, [activationConnection, digest("e"), ids.traveler]);
    await db.query("update travelers set is_organizer=false where id=$1", [ids.traveler]);
    const activation = await runLifecycleCommand(
      "activate_trip_agent_command",
      activationConnection,
      "70000000-0000-4000-8000-000000000009",
      digest("b"),
      { groupDigest: digest("b"), privacyNoticeVersion: "v1", receiptDigest: digest("d") },
    );
    expect(activation.rows[0].result).toEqual({ code: "not_ready" });

    await db.exec("truncate table trip_agent_connections cascade");
    await db.query("update travelers set is_organizer=true where id=$1", [ids.traveler]);
    const announcementConnection = await insertConnection();
    await pairConnection(announcementConnection);
    await db.query("update trip_agent_connections set status='paused',paused_at=now(),whatsapp_group_digest=$2,whatsapp_group_label='Family trip',granted_scopes=array['announcement.write'] where id=$1", [announcementConnection, digest("b")]);
    const announcement = await runLifecycleCommand(
      "report_trip_agent_announcement_command",
      announcementConnection,
      "70000000-0000-4000-8000-000000000010",
      digest("b"),
      { actionId: "80000000-0000-4000-8000-000000000001", deliveryStatus: "delivered", providerMessageDigest: null },
    );
    expect(announcement.rows[0].result).toEqual({ code: "authority_changed" });
  });

  it("defensively denies a bot organizer at rotation, mapping, replacement, and activation SQL boundaries", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query("update travelers set is_bot=true where id=$1", [ids.traveler]);
    const before = (await db.query<{ updated_at: Date }>("select updated_at from trip_agent_connections where id=$1", [connectionId])).rows[0];
    expect((await db.query("select * from rotate_trip_agent_credential($1,$2,$3,$4,$5)",
      [connectionId, before.updated_at, digest("d"), ids.traveler, "2026-09-04T12:00:00Z"])).rows).toHaveLength(0);

    const mapping = await db.query<{ id: string; updated_at: Date }>(`insert into trip_agent_participant_mappings
      (connection_id,lifecycle_generation,external_participant_digest,status) values($1,1,$2,'suggested') returning id,updated_at`, [connectionId,digest("e")]);
    expect((await transitionMapping({ connectionId, mappingId: mapping.rows[0].id, actorId: ids.traveler,
      action: "confirm", travelerId: ids.tripTraveler, expectedUpdatedAt: mapping.rows[0].updated_at,
      expectedStatus: "suggested" })).rows).toHaveLength(0);

    await db.query("update trip_agent_participant_mappings set traveler_id=$2,status='confirmed',confirmed_by=$2,confirmed_at=now() where id=$1", [mapping.rows[0].id,ids.traveler]);
    await db.query("update trip_agent_connections set whatsapp_group_digest=$2,whatsapp_group_label='Bot group' where id=$1", [connectionId,digest("b")]);
    expect((await db.query("select * from activate_trip_agent_connection($1,$2,'v1',$3,$4)",
      [connectionId,digest("b"),digest("d"),"2026-09-04T12:00:00Z"])).rows).toHaveLength(0);

    await db.query("update trip_agent_connections set status='revoked',credential_digest=null,revoked_at=now(),updated_at=clock_timestamp()+interval '1 second' where id=$1", [connectionId]);
    const terminal = (await db.query<{ updated_at: Date }>("select updated_at from trip_agent_connections where id=$1", [connectionId])).rows[0];
    expect((await db.query("select * from replace_trip_agent_connection($1,$2,'hermes',$3,$4,$5,$6)",
      [connectionId,terminal.updated_at,digest("f"),"2026-09-04T12:10:00Z",ids.traveler,"2026-09-04T12:00:00Z"])).rows).toHaveLength(0);
  });

  it("enforces digest lifecycle rules and pairs atomically without activating", async () => {
    const connectionId = await insertConnection();

    await expect(
      db.query(
        "update trip_agent_connections set credential_digest = $2 where id = $1",
        [connectionId, digest("c")],
      ),
    ).rejects.toThrow(/check/i);

    const paired = await db.query<{ connection_id: string; trip_id: string }>(
      `select * from consume_trip_agent_pairing($1, 'openclaw', $2, $3)`,
      [digest("a"), digest("c"), "2026-09-03T22:00:00Z"],
    );
    const stored = await db.query<{
      status: string;
      credential_digest: string | null;
      pairing_code_digest: string | null;
      pairing_expires_at: string | null;
    }>(
      `select status, credential_digest, pairing_code_digest, pairing_expires_at
       from trip_agent_connections where id = $1`,
      [connectionId],
    );

    expect(paired.rows).toEqual([{ connection_id: connectionId, trip_id: ids.trip }]);
    expect(stored.rows[0]).toEqual({
      status: "paired",
      credential_digest: digest("c"),
      pairing_code_digest: null,
      pairing_expires_at: null,
    });
    await expect(
      db.query(`select * from consume_trip_agent_pairing($1, 'openclaw', $2, $3)`, [
        digest("a"),
        digest("d"),
        "2026-09-03T22:00:00Z",
      ]),
    ).rejects.toThrow(/invalid|expired|used/i);
  });

  it("rejects expired and provider-mismatched pairing exchanges", async () => {
    await insertConnection();

    await expect(
      db.query(`select * from consume_trip_agent_pairing($1, 'hermes', $2, $3)`, [
        digest("a"),
        digest("c"),
        "2026-09-03T22:00:00Z",
      ]),
    ).rejects.toThrow(/invalid|expired|used/i);
    await expect(
      db.query(`select * from consume_trip_agent_pairing($1, 'openclaw', $2, $3)`, [
        digest("a"),
        digest("c"),
        "2026-09-03T23:00:00Z",
      ]),
    ).rejects.toThrow(/invalid|expired|used/i);
  });

  it("rotates a credential and its audit atomically against the observed version", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const before = await db.query<{ updated_at: string; credential_digest: string }>(
      "select updated_at, credential_digest from trip_agent_connections where id = $1",
      [connectionId],
    );
    const requestedAt = new Date(new Date(before.rows[0].updated_at).getTime() + 60_000);

    const rotated = await db.query<{
      id: string;
      status: string;
      credential_digest: string;
      updated_at: string;
    }>(
      `select * from rotate_trip_agent_credential($1, $2, $3, $4, $5)`,
      [connectionId, before.rows[0].updated_at, digest("d"), ids.traveler, requestedAt],
    );

    expect(rotated.rows).toHaveLength(1);
    expect(rotated.rows[0]).toMatchObject({
      id: connectionId,
      status: "paired",
      updated_at: requestedAt,
    });
    const storedCredential = await db.query<{ credential_digest: string }>(
      "select credential_digest from trip_agent_connections where id = $1",
      [connectionId],
    );
    expect(storedCredential.rows).toEqual([{ credential_digest: digest("d") }]);
    const audit = await db.query<{ kind: string; detail: object }>(
      "select kind, detail from trip_events where trip_id = $1",
      [ids.trip],
    );
    expect(audit.rows).toEqual([{
      kind: "trip_agent_credential_rotated",
      detail: { connectionId, provider: "openclaw", lifecycleStatus: "paired" },
    }]);

    const stale = await db.query(
      `select * from rotate_trip_agent_credential($1, $2, $3, $4, $5)`,
      [connectionId, before.rows[0].updated_at, digest("e"), ids.traveler, "2026-09-04T12:01:00Z"],
    );
    expect(stale.rows).toEqual([]);
  });

  it.each([
    ["missing", "30000000-0000-4000-8000-000000000001"],
    ["from another trip", ids.otherTraveler],
  ])("fails closed when the credential-rotation actor is %s", async (_case, actorId) => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const before = await db.query<{ updated_at: string; credential_digest: string }>(
      "select updated_at, credential_digest from trip_agent_connections where id = $1",
      [connectionId],
    );

    const rotated = await db.query(
      `select * from rotate_trip_agent_credential($1, $2, $3, $4, $5)`,
      [connectionId, before.rows[0].updated_at, digest("d"), actorId, "2026-09-04T12:00:00Z"],
    );

    expect(rotated.rows).toEqual([]);

    const after = await db.query<{ credential_digest: string; count: number }>(
      `select c.credential_digest,
              (select count(*)::integer from trip_events where trip_id = c.trip_id) as count
       from trip_agent_connections c where c.id = $1`,
      [connectionId],
    );
    expect(after.rows).toEqual([{ credential_digest: before.rows[0].credential_digest, count: 0 }]);
  });

  it("strictly advances same-timestamp rotations so only one observed version can succeed", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const before = await db.query<{ updated_at: Date }>(
      "select updated_at from trip_agent_connections where id = $1",
      [connectionId],
    );

    const attempts = await Promise.all([
      db.query(`select * from rotate_trip_agent_credential($1, $2, $3, $4, $5)`, [
        connectionId, before.rows[0].updated_at, digest("d"), ids.traveler, before.rows[0].updated_at,
      ]),
      db.query(`select * from rotate_trip_agent_credential($1, $2, $3, $4, $5)`, [
        connectionId, before.rows[0].updated_at, digest("e"), ids.traveler, before.rows[0].updated_at,
      ]),
    ]);

    expect(attempts.map((attempt) => attempt.rows.length).sort()).toEqual([0, 1]);
    const stored = await db.query<{ advanced: boolean; credential_digest: string; audits: number }>(
      `select c.updated_at > $2::timestamptz as advanced, c.credential_digest,
              (select count(*)::integer from trip_events where trip_id = c.trip_id) as audits
       from trip_agent_connections c where c.id = $1`,
      [connectionId, before.rows[0].updated_at],
    );
    expect(stored.rows[0].advanced).toBe(true);
    expect([digest("d"), digest("e")]).toContain(stored.rows[0].credential_digest);
    expect(stored.rows[0].audits).toBe(1);
  });

  it("refuses credential rotation by a same-trip human non-organizer", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const before = (await db.query<{ updated_at: Date; credential_digest: string }>(
      "select updated_at,credential_digest from trip_agent_connections where id=$1",
      [connectionId],
    )).rows[0];

    const rotated = await db.query("select * from rotate_trip_agent_credential($1,$2,$3,$4,$5)", [
      connectionId, before.updated_at, digest("d"), ids.tripTraveler, "2026-09-04T12:00:00Z",
    ]);

    expect(rotated.rows).toEqual([]);
    expect((await db.query("select credential_digest from trip_agent_connections where id=$1", [connectionId])).rows)
      .toEqual([{ credential_digest: before.credential_digest }]);
  });

  it("keeps confirmed participant mappings unique and within the connection trip", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query(
      `insert into trip_agent_participant_mappings
         (connection_id, external_participant_digest, traveler_id, status, confirmed_by, confirmed_at)
       values ($1, $2, $3, 'confirmed', $3, now())`,
      [connectionId, digest("1"), ids.traveler],
    );

    await expect(
      db.query(
        `insert into trip_agent_participant_mappings
           (connection_id, external_participant_digest, traveler_id, status, confirmed_by, confirmed_at)
         values ($1, $2, $3, 'confirmed', $3, now())`,
        [connectionId, digest("2"), ids.traveler],
      ),
    ).rejects.toThrow(/unique/i);
    await expect(
      db.query(
        `insert into trip_agent_participant_mappings
           (connection_id, external_participant_digest, traveler_id, status, confirmed_by, confirmed_at)
         values ($1, $2, $3, 'confirmed', $4, now())`,
        [connectionId, digest("3"), ids.otherTraveler, ids.traveler],
      ),
    ).rejects.toThrow(/same.trip/i);

    await db.query(
      `insert into trip_agent_participant_mappings
         (connection_id, external_participant_digest, traveler_id, status)
       values ($1, $2, $3, 'suggested')`,
      [connectionId, digest("4"), ids.traveler],
    );
    const count = await db.query<{ count: number }>(
      "select count(*)::integer as count from trip_agent_participant_mappings",
    );
    expect(count.rows[0].count).toBe(2);
  });

  it("prevents parent rows from moving a confirmed mapping across trips", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query(
      `insert into trip_agent_participant_mappings
         (connection_id, external_participant_digest, traveler_id, status, confirmed_by, confirmed_at)
       values ($1, $2, $3, 'confirmed', $3, now())`,
      [connectionId, digest("5"), ids.traveler],
    );

    await expect(
      db.query("update travelers set trip_id = $2 where id = $1", [ids.traveler, ids.otherTrip]),
    ).rejects.toThrow(/foreign key|confirmed participant mapping|same.trip/i);
    await expect(
      db.query("update trip_agent_connections set trip_id = $2 where id = $1", [connectionId, ids.otherTrip]),
    ).rejects.toThrow(/foreign key|confirmed participant mapping|same.trip/i);
  });

  it("serializes mapping confirmation against a concurrent parent trip change", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);

    const outcomes = await Promise.allSettled([
      db.query(
        `insert into trip_agent_participant_mappings
           (connection_id, external_participant_digest, traveler_id, status, confirmed_by, confirmed_at)
         values ($1, $2, $3, 'confirmed', $3, now())`,
        [connectionId, digest("6"), ids.traveler],
      ),
      db.query(
        "update trip_agent_connections set trip_id = $2 where id = $1",
        [connectionId, ids.otherTrip],
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const violations = await db.query<{ count: number }>(
      `select count(*)::integer as count
       from trip_agent_participant_mappings m
       join trip_agent_connections c on c.id = m.connection_id
       join travelers t on t.id = m.traveler_id
       where m.status = 'confirmed' and c.trip_id <> t.trip_id`,
    );
    expect(violations.rows).toEqual([{ count: 0 }]);
  });

  it("transitions a mapping and its identifiers-only audit in one CAS transaction", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const inserted = await db.query<{ id: string; updated_at: Date }>(
      `insert into trip_agent_participant_mappings
         (connection_id, external_participant_digest, status)
       values ($1, $2, 'suggested')
       returning id, updated_at`,
      [connectionId, digest("6")],
    );

    const confirmed = await transitionMapping({
      connectionId,
      mappingId: inserted.rows[0].id,
      action: "confirm",
      travelerId: ids.tripTraveler,
      expectedUpdatedAt: inserted.rows[0].updated_at,
      expectedStatus: "suggested",
    });

    expect(confirmed.rows).toHaveLength(1);
    expect(confirmed.rows[0]).toMatchObject({
      id: inserted.rows[0].id,
      traveler_id: ids.tripTraveler,
      status: "confirmed",
    });
    const event = await db.query<{ kind: string; detail: Record<string, string> }>(
      "select kind, detail from trip_events where trip_id = $1",
      [ids.trip],
    );
    expect(event.rows).toEqual([{
      kind: "agent_participant_mapping_confirmed",
      detail: { mappingId: inserted.rows[0].id, travelerId: ids.tripTraveler },
    }]);
    expect(Object.keys(event.rows[0].detail).sort()).toEqual(["mappingId", "travelerId"]);
  });

  it("defensively refuses a non-organizer actor and a cross-trip target", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const inserted = await db.query<{ id: string; updated_at: Date }>(
      `insert into trip_agent_participant_mappings
         (connection_id, external_participant_digest, status)
       values ($1, $2, 'suggested')
       returning id, updated_at`,
      [connectionId, digest("6")],
    );
    const base = {
      connectionId,
      mappingId: inserted.rows[0].id,
      action: "confirm" as const,
      expectedUpdatedAt: inserted.rows[0].updated_at,
      expectedStatus: "suggested" as const,
    };

    expect((await transitionMapping({
      ...base,
      actorId: ids.tripTraveler,
      travelerId: ids.alternateTripTraveler,
    })).rows).toHaveLength(0);
    expect((await transitionMapping({
      ...base,
      travelerId: ids.otherTraveler,
    })).rows).toHaveLength(0);

    const stored = await db.query<{ status: string; traveler_id: string | null }>(
      "select status, traveler_id from trip_agent_participant_mappings where id = $1",
      [inserted.rows[0].id],
    );
    expect(stored.rows).toEqual([{ status: "suggested", traveler_id: null }]);
  });

  it("defensively refuses a null mapping action", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const inserted = await db.query<{ id: string; updated_at: Date }>(
      `insert into trip_agent_participant_mappings
         (connection_id, external_participant_digest, status)
       values ($1, $2, 'suggested')
       returning id, updated_at`,
      [connectionId, digest("6")],
    );

    const refused = await db.query(
      `select * from transition_trip_agent_participant_mapping(
         $1::uuid, $2::uuid, 1::integer, $3::uuid, $4::uuid, null::text, null::uuid,
         $5::timestamptz, 'suggested'::text, null::uuid, $6::timestamptz
       )`,
      [
        connectionId,
        ids.trip,
        inserted.rows[0].id,
        ids.traveler,
        inserted.rows[0].updated_at,
        "2026-09-04T12:00:00Z",
      ],
    );

    expect(refused.rows).toHaveLength(0);
    const stored = await db.query<{ status: string; traveler_id: string | null }>(
      "select status, traveler_id from trip_agent_participant_mappings where id = $1",
      [inserted.rows[0].id],
    );
    expect(stored.rows).toEqual([{ status: "suggested", traveler_id: null }]);
  });

  it("rolls back a mapping transition when its audit insert fails", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const inserted = await db.query<{ id: string; updated_at: Date }>(
      `insert into trip_agent_participant_mappings
         (connection_id, external_participant_digest, status)
       values ($1, $2, 'suggested')
       returning id, updated_at`,
      [connectionId, digest("6")],
    );
    await db.exec(`
      create function fail_trip_agent_mapping_audit()
      returns trigger language plpgsql as $$
      begin
        if new.kind = 'agent_participant_mapping_confirmed' then
          raise exception 'mapping audit refused';
        end if;
        return new;
      end;
      $$;
      create trigger fail_trip_agent_mapping_audit
      before insert on trip_events
      for each row execute function fail_trip_agent_mapping_audit();
    `);

    try {
      await expect(transitionMapping({
        connectionId,
        mappingId: inserted.rows[0].id,
        action: "confirm",
        travelerId: ids.tripTraveler,
        expectedUpdatedAt: inserted.rows[0].updated_at,
        expectedStatus: "suggested",
      })).rejects.toThrow(/mapping audit refused/i);
    } finally {
      await db.exec(`
        drop trigger fail_trip_agent_mapping_audit on trip_events;
        drop function fail_trip_agent_mapping_audit();
      `);
    }

    const stored = await db.query<{ status: string; traveler_id: string | null; events: number }>(
      `select m.status, m.traveler_id,
              (select count(*)::integer from trip_events where trip_id = m.trip_id) as events
       from trip_agent_participant_mappings m where m.id = $1`,
      [inserted.rows[0].id],
    );
    expect(stored.rows).toEqual([{ status: "suggested", traveler_id: null, events: 0 }]);
  });

  it("allows only one concurrent remap from the same observed mapping version", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const inserted = await db.query<{ id: string; updated_at: Date }>(
      `insert into trip_agent_participant_mappings
         (connection_id, external_participant_digest, traveler_id, status, confirmed_by, confirmed_at)
       values ($1, $2, $3, 'confirmed', $3, now())
       returning id, updated_at`,
      [connectionId, digest("6"), ids.traveler],
    );
    const base = {
      connectionId,
      mappingId: inserted.rows[0].id,
      action: "remap" as const,
      expectedUpdatedAt: inserted.rows[0].updated_at,
      expectedStatus: "confirmed" as const,
      expectedTravelerId: ids.traveler,
      at: "2026-09-04T12:00:00Z",
    };

    const attempts = await Promise.all([
      transitionMapping({ ...base, travelerId: ids.tripTraveler }),
      transitionMapping({ ...base, travelerId: ids.alternateTripTraveler }),
    ]);

    expect(attempts.map((attempt) => attempt.rows.length).sort()).toEqual([0, 1]);
    const winner = attempts.find((attempt) => attempt.rows.length === 1)?.rows[0].traveler_id;
    const event = await db.query<{ detail: Record<string, string> }>(
      `select detail from trip_events
       where trip_id = $1 and kind = 'agent_participant_mapping_changed'`,
      [ids.trip],
    );
    expect(event.rows).toEqual([{
      detail: {
        mappingId: inserted.rows[0].id,
        previousTravelerId: ids.traveler,
        travelerId: winner,
      },
    }]);
    expect(Object.keys(event.rows[0].detail).sort()).toEqual([
      "mappingId", "previousTravelerId", "travelerId",
    ]);
  });

  it("rejects duplicate idempotency keys and cross-trip action records", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await insertAction(connectionId);

    await expect(insertAction(connectionId)).rejects.toThrow(/unique/i);
    await expect(
      insertAction(connectionId, { operation: "commit_change" }),
    ).rejects.toThrow(/unique/i);
    await expect(
      insertAction(connectionId, { tripId: ids.otherTrip, idempotencyKey: "request-2" }),
    ).rejects.toThrow(/foreign key/i);

    const stored = await db.query<{ operation: string; normalized_request: object }>(
      `select operation, normalized_request from trip_agent_actions
       where connection_id = $1 and idempotency_key = 'request-1'`,
      [connectionId],
    );
    expect(stored.rows).toEqual([{
      operation: "read_today",
      normalized_request: { dayIndex: 0 },
    }]);
  });

  it("accepts only object-or-null canonical references and action results", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const action = await insertAction(connectionId);
    const actionId = action.rows[0].id;

    await expect(
      db.query(
        `update trip_agent_actions set canonical_reference = '"item-1"'::jsonb where id = $1`,
        [actionId],
      ),
    ).rejects.toThrow(/check/i);
    await expect(
      db.query("update trip_agent_actions set result = '42'::jsonb where id = $1", [actionId]),
    ).rejects.toThrow(/check/i);

    await db.query(
      `update trip_agent_actions
       set canonical_reference = '{"kind":"itinerary_item","id":"item-1"}'::jsonb,
           result = '{"ok":true}'::jsonb
       where id = $1`,
      [actionId],
    );
    const stored = await db.query<{ canonical_reference: object; result: object }>(
      "select canonical_reference, result from trip_agent_actions where id = $1",
      [actionId],
    );
    expect(stored.rows).toEqual([{
      canonical_reference: { kind: "itinerary_item", id: "item-1" },
      result: { ok: true },
    }]);
  });

  it("accepts only the normative operation, action, authority, announcement, and rate enums", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const action = await insertAction(connectionId);
    const actionId = action.rows[0].id;
    const operations = [
      "register_group", "readiness", "activate", "read_context", "read_today",
      "search_options", "read_decisions", "preview_change", "commit_change", "vote",
      "decide", "report_announcement", "poll_proactive_events",
    ];
    const statuses = [
      "received", "previewed", "executing", "awaiting_vote", "awaiting_confirmation",
      "succeeded", "rejected", "cancelled", "failed", "unknown", "refused", "expired",
    ];
    const authorities = ["allowed", "requires_organizer_confirmation", "denied"];
    const announcements = ["pending", "delivered", "failed"];

    for (const operation of operations) {
      await db.query("update trip_agent_actions set operation = $2 where id = $1", [actionId, operation]);
    }
    for (const status of statuses) {
      await db.query("update trip_agent_actions set status = $2 where id = $1", [actionId, status]);
    }
    for (const authority of authorities) {
      await db.query("update trip_agent_actions set authority_decision = $2 where id = $1", [actionId, authority]);
    }
    for (const announcement of announcements) {
      await db.query("update trip_agent_actions set announcement_status = $2 where id = $1", [actionId, announcement]);
    }

    await expect(db.query("update trip_agent_actions set operation = 'other' where id = $1", [actionId])).rejects.toThrow(/check/i);
    await expect(db.query("update trip_agent_actions set status = 'pending' where id = $1", [actionId])).rejects.toThrow(/check/i);
    await expect(db.query("update trip_agent_actions set authority_decision = 'maybe' where id = $1", [actionId])).rejects.toThrow(/check/i);
    await expect(db.query("update trip_agent_actions set announcement_status = 'sent' where id = $1", [actionId])).rejects.toThrow(/check/i);

    for (const bucket of ["setup", "read", "mutation"]) {
      const consumed = await db.query<{ allowed: boolean; count: number }>(
        "select allowed, count from consume_trip_agent_rate_limit($1, $2, 10, $3)",
        [connectionId, bucket, "2026-09-03T22:12:30Z"],
      );
      expect(consumed.rows[0]).toEqual({ allowed: true, count: 1 });
    }
    await expect(
      db.query("select * from consume_trip_agent_rate_limit($1, 'research', 10, $2)", [
        connectionId,
        "2026-09-03T22:12:30Z",
      ]),
    ).rejects.toThrow(/bucket|check/i);
  });

  it("atomically consumes one fixed minute rate window", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    const calls = await Promise.all(Array.from({ length: 20 }, () =>
      db.query<{ allowed: boolean; count: number; retry_after: number }>(
        "select * from consume_trip_agent_rate_limit($1, 'read', 10, $2)",
        [connectionId, "2026-09-03T22:12:30Z"],
      )));
    const rows = calls.map((call) => call.rows[0]).sort((left, right) => left.count - right.count);

    expect(rows.map((row) => row.count)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(rows.filter((row) => row.allowed)).toHaveLength(10);
    expect(rows.filter((row) => !row.allowed)).toHaveLength(10);
    expect(rows[19].retry_after).toBe(30);

    const window = await db.query<{ request_count: number }>(
      `select request_count from trip_agent_rate_windows
       where connection_id = $1 and bucket = 'read'`,
      [connectionId],
    );
    expect(window.rows).toEqual([{ request_count: 20 }]);
  });

  it("activates only after transactional readiness revalidation", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query(
      `update trip_agent_connections
       set whatsapp_group_digest = $2, whatsapp_group_label = 'Family group'
       where id = $1`,
      [connectionId, digest("b")],
    );

    const missingOrganizer = await db.query(
      "select * from activate_trip_agent_connection($1, $2, 'v1', $3, $4)",
      [connectionId, digest("b"), digest("d"), "2026-09-04T12:00:00Z"],
    );
    expect(missingOrganizer.rows).toHaveLength(0);

    await db.query(
      `insert into trip_agent_participant_mappings
         (connection_id, external_participant_digest, traveler_id, status, confirmed_by, confirmed_at)
       values ($1, $2, $3, 'confirmed', $3, now())`,
      [connectionId, digest("e"), ids.traveler],
    );
    for (const [groupDigest, noticeVersion, receiptDigest, at] of [
      [digest("f"), "v1", digest("d"), "2026-09-04T12:00:00Z"],
      [digest("b"), "v2", digest("d"), "2026-09-04T12:00:00Z"],
      [null, "v1", digest("d"), "2026-09-04T12:00:00Z"],
      [digest("b"), null, digest("d"), "2026-09-04T12:00:00Z"],
      [digest("b"), "v1", null, "2026-09-04T12:00:00Z"],
      [digest("b"), "v1", "not-a-digest", "2026-09-04T12:00:00Z"],
      [digest("b"), "v1", digest("d"), null],
    ]) {
      const refused = await db.query(
        `select * from activate_trip_agent_connection(
           $1::uuid, $2::text, $3::text, $4::text, $5::timestamptz
         )`,
        [connectionId, groupDigest, noticeVersion, receiptDigest, at],
      );
      expect(refused.rows).toHaveLength(0);
    }

    const activated = await db.query<{ status: string; activated_at: string }>(
      "select * from activate_trip_agent_connection($1, $2, 'v1', $3, $4)",
      [connectionId, digest("b"), digest("d"), "2026-09-04T12:00:00Z"],
    );
    const stored = await db.query<{
      status: string;
      privacy_notice_version: string;
      privacy_notice_message_digest: string;
      granted_scopes: string[];
    }>(
      `select status, privacy_notice_version, privacy_notice_message_digest, granted_scopes
       from trip_agent_connections where id = $1`,
      [connectionId],
    );

    expect(activated.rows).toHaveLength(1);
    expect(activated.rows[0].status).toBe("active");
    expect(stored.rows[0]).toEqual({
      status: "active",
      privacy_notice_version: "v1",
      privacy_notice_message_digest: digest("d"),
      granted_scopes: ["connector.setup"],
    });
  });

  it("refuses activation when connector.setup was removed before the transaction", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query(
      `update trip_agent_connections
       set whatsapp_group_digest = $2,
           whatsapp_group_label = 'Family group',
           granted_scopes = array[]::text[]
       where id = $1`,
      [connectionId, digest("b")],
    );
    await db.query(
      `insert into trip_agent_participant_mappings
         (connection_id, external_participant_digest, traveler_id, status, confirmed_by, confirmed_at)
       values ($1, $2, $3, 'confirmed', $3, now())`,
      [connectionId, digest("e"), ids.traveler],
    );

    const activated = await db.query(
      "select * from activate_trip_agent_connection($1, $2, 'v1', $3, $4)",
      [connectionId, digest("b"), digest("d"), "2026-09-04T12:00:00Z"],
    );

    expect(activated.rows).toHaveLength(0);
    const stored = await db.query<{ status: string }>(
      "select status from trip_agent_connections where id = $1",
      [connectionId],
    );
    expect(stored.rows).toEqual([{ status: "paired" }]);
  });

  it("refuses activation after the confirmed organizer mapping is revoked", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query(
      `update trip_agent_connections
       set whatsapp_group_digest = $2, whatsapp_group_label = 'Family group'
       where id = $1`,
      [connectionId, digest("b")],
    );
    await db.query(
      `insert into trip_agent_participant_mappings
         (connection_id, external_participant_digest, traveler_id, status,
          confirmed_by, confirmed_at, revoked_at)
       values ($1, $2, $3, 'revoked', $3, now(), now())`,
      [connectionId, digest("e"), ids.traveler],
    );

    const activated = await db.query(
      "select * from activate_trip_agent_connection($1, $2, 'v1', $3, $4)",
      [connectionId, digest("b"), digest("d"), "2026-09-04T12:00:00Z"],
    );

    expect(activated.rows).toHaveLength(0);
  });

  it("serializes activation with organizer-mapping revocation without deadlock", async () => {
    const connectionId = await insertConnection();
    await pairConnection(connectionId);
    await db.query(
      `update trip_agent_connections
       set whatsapp_group_digest = $2, whatsapp_group_label = 'Family group'
       where id = $1`,
      [connectionId, digest("b")],
    );
    const mapping = await db.query<{ id: string; updated_at: Date }>(
      `insert into trip_agent_participant_mappings
         (connection_id, external_participant_digest, traveler_id, status, confirmed_by, confirmed_at)
       values ($1, $2, $3, 'confirmed', $3, now())
       returning id, updated_at`,
      [connectionId, digest("e"), ids.traveler],
    );

    const [activation, revocation] = await Promise.all([
      db.query("select * from activate_trip_agent_connection($1, $2, 'v1', $3, $4)", [
        connectionId, digest("b"), digest("d"), "2026-09-04T12:00:00Z",
      ]),
      transitionMapping({
        connectionId,
        mappingId: mapping.rows[0].id,
        action: "revoke",
        expectedUpdatedAt: mapping.rows[0].updated_at,
        expectedStatus: "confirmed",
        expectedTravelerId: ids.traveler,
      }),
    ]);

    expect(revocation.rows).toHaveLength(1);
    expect([0, 1]).toContain(activation.rows.length);
    const stored = await db.query<{ connection_status: string; mapping_status: string }>(
      `select c.status as connection_status, m.status as mapping_status
       from trip_agent_connections c
       join trip_agent_participant_mappings m on m.connection_id = c.id
       where c.id = $1 and m.id = $2`,
      [connectionId, mapping.rows[0].id],
    );
    expect(stored.rows[0].mapping_status).toBe("revoked");
    expect(stored.rows[0].connection_status).toBe(activation.rows.length ? "active" : "paired");
  });

  it("denies all gateway tables and functions to public, anon, and authenticated", async () => {
    const tables = [
      "trip_agent_connections",
      "trip_agent_participant_mappings",
      "trip_agent_actions",
      "trip_agent_rate_windows",
    ];
    const functions = [
      "claim_trip_agent_action(uuid,uuid,uuid,text,text,text,timestamp with time zone,boolean,jsonb)",
      "finalize_trip_agent_preview(uuid,uuid,uuid,text,text,jsonb,text,text)",
      "write_trip_agent_action_state(uuid,uuid,integer,uuid,text,text,jsonb)",
      "register_trip_agent_group_command(uuid,uuid,integer,text,text,jsonb,timestamp with time zone)",
      "activate_trip_agent_command(uuid,uuid,integer,text,text,jsonb,timestamp with time zone)",
      "report_trip_agent_announcement_command(uuid,uuid,integer,text,text,jsonb,timestamp with time zone)",
      "create_plan_proposal(uuid,uuid,uuid,text,integer,text,text,uuid,jsonb)",
      "create_suggestion_proposal(uuid,uuid,text,jsonb)",
      "trip_agent_change_state(uuid,jsonb,text)",
      "trip_agent_item_state(itinerary_items)",
      "consume_trip_agent_pairing(text,text,text,timestamp with time zone)",
      "consume_trip_agent_rate_limit(uuid,text,integer,timestamp with time zone)",
      "rotate_trip_agent_credential(uuid,timestamp with time zone,text,uuid,timestamp with time zone)",
      "replace_trip_agent_connection(uuid,timestamp with time zone,text,text,timestamp with time zone,uuid,timestamp with time zone)",
      "activate_trip_agent_connection(uuid,text,text,text,timestamp with time zone)",
      "transition_trip_agent_participant_mapping(uuid,uuid,integer,uuid,uuid,text,uuid,timestamp with time zone,text,uuid,timestamp with time zone)",
    ];

    for (const role of ["public", "anon", "authenticated"]) {
      for (const table of tables) {
        const privileges = await db.query<{ allowed: boolean }>(
          "select has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE') as allowed",
          [role, table],
        );
        expect(privileges.rows[0].allowed).toBe(false);
      }
      for (const fn of functions) {
        const privilege = await db.query<{ allowed: boolean }>(
          "select has_function_privilege($1, $2, 'EXECUTE') as allowed",
          [role, fn],
        );
        expect(privilege.rows[0].allowed).toBe(false);
      }
    }

    for (const table of tables) {
      const protection = await db.query<{ relrowsecurity: boolean; service_access: boolean }>(
        `select c.relrowsecurity,
                has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as service_access
         from pg_class c where c.oid = $1::regclass`,
        [table],
      );
      expect(protection.rows[0]).toEqual({ relrowsecurity: true, service_access: true });
    }
  });
});
