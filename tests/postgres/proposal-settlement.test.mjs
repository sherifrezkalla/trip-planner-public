import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Client } from 'pg';

// Deliberately outside the normal unit suite. Never silently skip the actual
// multi-backend proof, and never destroy an existing developer database.
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required: supply an empty, disposable PostgreSQL 16 database.');
const clients = Array.from({length:3}, () => new Client({connectionString:process.env.TEST_DATABASE_URL}));
const [writer, settler, observer] = clients;
let writerPid, settlerPid;
before(async () => {
  await Promise.all(clients.map(c => c.connect()));
  assert.equal((await writer.query("select count(*)::int as n from pg_tables where schemaname='public'")).rows[0].n,0,'TEST_DATABASE_URL must reference an empty test database');
  assert.equal(Math.floor(Number((await writer.query('show server_version_num')).rows[0].server_version_num)/10000),16);
  await writer.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
    end $$;
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);`);
  for (const file of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort()) {
    await writer.query(readFileSync(`supabase/migrations/${file}`,'utf8'));
  }
  writerPid=(await writer.query('select pg_backend_pid() as pid')).rows[0].pid;
  settlerPid=(await settler.query('select pg_backend_pid() as pid')).rows[0].pid;
});
after(async () => { await Promise.all(clients.map(c=>c.end())); });

async function fixture() {
  const trip=randomUUID(), humans=[randomUUID(),randomUUID(),randomUUID()];
  await writer.query(`insert into trips(id,slug,destination_name,destination_place_id,lat,lng,start_date,end_date,budget_level)
    values($1::uuid,$1::text,'Test','test',1,1,'2099-01-01','2099-01-07','mid')`,[trip]);
  for (const [i,id] of humans.entries()) await writer.query(`insert into travelers(id,trip_id,display_name,token,interests,pace,dietary,is_organizer)
    values($1::uuid,$2,'Test',$1::text,array['art'],'balanced','none',$3)`,[id,trip,i===0]);
  const proposal=(await writer.query("select create_suggestion_proposal($1,$2,'Museum') as id",[trip,humans[0]])).rows[0].id;
  await writer.query('insert into plan_proposal_votes(proposal_id,traveler_id,value) values($1,$2,1)',[proposal,humans[1]]);
  const settlement={status:'applied',reasonCode:'approved',yes:2,no:0,needed:2,travelerCount:3};
  const legacy=(client=settler,value=settlement) => client.query("select settle_plan_proposal_guarded($1,$2,null,'Applied',$3)",[proposal,humans[0],value]);
  const connection=(await writer.query(`insert into trip_agent_connections(trip_id,provider,status,credential_digest,whatsapp_group_digest,granted_scopes)
    values($1,'openclaw','active',$2,$3,array['trip.vote']) returning id`,[trip,randomUUID().replaceAll('-','').repeat(2),'b'.repeat(64)])).rows[0].id;
  await writer.query(`insert into trip_agent_participant_mappings(connection_id,external_participant_digest,traveler_id,status,confirmed_by,confirmed_at)
    values($1,$2,$3,'confirmed',$3,now())`,[connection,'e'.repeat(64),humans[0]]);
  async function action(operation,request,status) {
    return (await writer.query(`insert into trip_agent_actions(connection_id,trip_id,idempotency_key,external_actor_digest,mapped_traveler_id,operation,normalized_request,authority_decision,status,proposal_id,canonical_reference)
      values($1,$2,$3,$4,$5,$6,$7,'allowed',$8,$9,jsonb_build_object('kind','plan_proposal','id',$9::uuid)) returning id`,
    [connection,trip,randomUUID(),'e'.repeat(64),humans[0],operation,request,status,proposal])).rows[0].id;
  }
  const target=await action('preview_change',{kind:'suggest',text:'Museum'},'awaiting_vote');
  const command=await action('vote',{actionId:target,vote:'up'},'executing');
  const gateway=(client=settler,value=settlement) => client.query("select settle_trip_agent_proposal_action($1,$2,$3,$4,$5,$6,$7,null,'Applied',$8)",
    [command,connection,trip,'e'.repeat(64),'b'.repeat(64),proposal,humans[0],value]);
  return {trip,humans,proposal,settlement,legacy,gateway,command};
}

async function waitForBlocked() {
  const deadline=Date.now()+10000;
  while (Date.now()<deadline) {
    const row=(await observer.query(`select wait_event_type,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1`,[settlerPid])).rows[0];
    if (row?.wait_event_type==='Lock' && row.blockers.includes(writerPid)) return;
    // Yield without a timing assumption. Only observed PostgreSQL lock waits
    // AND the actual blocking PID release the writer transaction.
    await new Promise(resolve=>setImmediate(resolve));
  }
  throw new Error('Settlement never demonstrably blocked on the writer transaction');
}

test('public limiter admits exactly the quota across concurrent identical buckets', async () => {
  const bucket=randomUUID();
  const limit=5;
  const results=await Promise.all(Array.from({length:18},(_,i) =>
    clients[i%clients.length].query('select record_place_lookup($1,$2,3600) as allowed',[bucket,limit])));
  assert.equal(results.filter(result=>result.rows[0].allowed).length,limit);
  assert.equal((await observer.query('select count(*)::int as n from place_lookups where client_hash=$1',[bucket])).rows[0].n,limit);
});

test('public limiter serializes one bucket while an unrelated bucket progresses', async () => {
  const bucket=randomUUID();
  let pending;
  await writer.query('begin');
  try {
    assert.equal((await writer.query('select record_place_lookup($1,1,3600) as allowed',[bucket])).rows[0].allowed,true);
    pending=settler.query('select record_place_lookup($1,1,3600) as allowed',[bucket]);
    await waitForBlocked();
    await observer.query("set statement_timeout='2s'");
    assert.equal((await observer.query('select record_place_lookup($1,1,3600) as allowed',[randomUUID()])).rows[0].allowed,true);
    await writer.query('commit');
    assert.equal((await pending).rows[0].allowed,false);
  } finally {
    await writer.query('rollback');
    if(pending) await pending;
    await observer.query('reset statement_timeout');
  }
});

for (const path of ['legacy','gateway']) for (const change of ['vote','join','bot','departure']) {
  test(`${path} rejects an uncommitted ${change} drift after waiting for its lock`, async () => {
    const f=await fixture();
    await writer.query('begin');
    let pending;
    try {
      if(change==='vote') await writer.query('update plan_proposal_votes set value=-1 where proposal_id=$1 and traveler_id=$2',[f.proposal,f.humans[1]]);
      if(change==='join') await writer.query("insert into travelers(trip_id,display_name,token,interests,pace,dietary) values($1,'Joined',$2,array['art'],'balanced','none')",[f.trip,randomUUID()]);
      if(change==='bot') await writer.query('update travelers set is_bot=true where id=$1',[f.humans[1]]);
      if(change==='departure') await writer.query('delete from travelers where id=$1',[f.humans[2]]);
      await settler.query('begin');
      pending=f[path]().then(()=>({ok:true}),error=>({error}));
      await waitForBlocked();
      await writer.query('commit');
      const result=await pending;
      assert.equal(result.error?.code,'TP008');
      await settler.query('rollback');
      assert.equal((await observer.query('select status from plan_proposals where id=$1',[f.proposal])).rows[0].status,'open');
      assert.equal((await observer.query('select count(*)::int as n from trip_suggestions where trip_id=$1',[f.trip])).rows[0].n,0);
      assert.equal((await observer.query('select status from trip_agent_actions where id=$1',[f.command])).rows[0].status,'executing');
    } finally {
      await writer.query('rollback');
      if(pending) await pending;
      await settler.query('rollback');
    }
  });
}

for (const winner of ['legacy','gateway']) test(`${winner} decisive settlement wins once against the other path`,async () => {
  const f=await fixture();
  let pending;
  await writer.query('begin');
  try {
    await f[winner](writer);
    await settler.query('begin');
    pending=f[winner==='legacy'?'gateway':'legacy']().then(()=>({ok:true}),error=>({error}));
    await waitForBlocked();
    await writer.query('commit');
    assert.equal((await pending).error?.code,'TP005');
    await settler.query('rollback');
    assert.equal((await observer.query('select count(*)::int as n from trip_suggestions where trip_id=$1',[f.trip])).rows[0].n,1);
    assert.equal((await observer.query('select status from plan_proposals where id=$1',[f.proposal])).rows[0].status,'applied');
    if(winner==='gateway') assert.deepEqual((await observer.query('select result from trip_agent_actions where id=$1',[f.command])).rows[0].result.settlement,f.settlement);
  } finally {
    await writer.query('rollback');
    if(pending) await pending;
    await settler.query('rollback');
  }
});

test('an unrelated sweep cannot block a bucket or count its locked expired rows', async () => {
  const bucket = randomUUID();
  await writer.query("insert into place_lookups(client_hash,created_at) values($1,now()-interval '2 days')", [bucket]);
  await writer.query('begin');
  try {
    // A different bucket sweeps B's expired row and holds its deletion lock.
    await writer.query('select record_place_lookup($1,1,3600)', [randomUUID()]);
    await settler.query('begin');
    await settler.query("set local lock_timeout='1s'");
    const result = await settler.query('select record_place_lookup($1,1,3600) as allowed', [bucket]);
    assert.equal(result.rows[0].allowed, true);
    assert.equal((await settler.query('select record_place_lookup($1,1,3600) as allowed', [bucket])).rows[0].allowed, false);
    await settler.query('commit');
    await writer.query('commit');
  } finally {
    await settler.query('rollback');
    await writer.query('rollback');
  }
});

async function removalFixture(phase) {
  const f=await fixture();
  const connection=(await writer.query('select connection_id from trip_agent_actions where id=$1',[f.command])).rows[0].connection_id;
  const actorDigest='f'.repeat(64);
  const mapping=(await writer.query(`insert into trip_agent_participant_mappings
    (connection_id,external_participant_digest,traveler_id,status,confirmed_by,confirmed_at)
    values($1,$2,$3,'confirmed',$4,now()) returning id`,[connection,actorDigest,f.humans[1],f.humans[0]])).rows[0].id;
  await writer.query('update trip_agent_actions set mapped_traveler_id=$2,external_actor_digest=$3,status=$4 where id=$1',
    [f.command,f.humans[1],actorDigest,phase==='prepare'?'received':'executing']);
  const remove=(client=settler) => client.query('select remove_trip_traveler_guarded($1,$2,$3) as result',[f.trip,f.humans[0],f.humans[1]]);
  const gateway=(client=settler) => phase==='prepare'
    ? client.query('select prepare_trip_agent_proposal_action($1,$2,$3,$4,$5)',[f.command,connection,f.trip,actorDigest,'b'.repeat(64)])
    : client.query("select settle_trip_agent_proposal_action($1,$2,$3,$4,$5,$6,$7,null,'Applied',$8)",
      [f.command,connection,f.trip,actorDigest,'b'.repeat(64),f.proposal,f.humans[1],f.settlement]);
  return {...f,connection,mapping,remove,gateway};
}

for (const phase of ['prepare','settle']) test(`mapped voter removal waits before traveler locks while gateway ${phase} finishes`, async () => {
  const f=await removalFixture(phase);
  let pending;
  await writer.query('begin');
  try {
    // Pause the gateway after its connection/mapping locks, before it locks
    // travelers. The former direct DELETE would hold the traveler and wait on
    // this mapping, deadlocking the subsequent real gateway RPC.
    await writer.query('select id from trip_agent_connections where id=$1 for update',[f.connection]);
    await writer.query('select id from trip_agent_participant_mappings where id=$1 for update',[f.mapping]);
    pending=f.remove().then(value=>({value}),error=>({error}));
    await waitForBlocked();
    await f.gateway(writer);
    await writer.query('commit');
    const result=await pending;
    assert.equal(result.error,undefined);
    assert.equal(result.value.rows[0].result,'removed');
    assert.equal((await observer.query('select id from travelers where id=$1',[f.humans[1]])).rowCount,0);
    assert.equal((await observer.query('select id from trip_agent_participant_mappings where id=$1',[f.mapping])).rowCount,0);
    assert.equal((await observer.query('select id from plan_proposal_votes where traveler_id=$1',[f.humans[1]])).rowCount,0);
    assert.equal((await observer.query('select count(*)::int as n from trip_suggestions where trip_id=$1',[f.trip])).rows[0].n,phase==='settle'?1:0);
    assert.equal((await observer.query('select status from trip_agent_actions where id=$1',[f.command])).rows[0].status,phase==='settle'?'succeeded':'executing');
  } finally {
    await writer.query('rollback');
    if(pending) await pending;
  }
});

for (const phase of ['prepare','settle']) test(`gateway ${phase} rechecks authority after mapped voter removal commits`, async () => {
  const f=await removalFixture(phase);
  let pending;
  await writer.query('begin');
  try {
    assert.equal((await f.remove(writer)).rows[0].result,'removed');
    pending=f.gateway().then(()=>({ok:true}),error=>({error}));
    await waitForBlocked();
    await writer.query('commit');
    assert.equal((await pending).error?.code,'TP006');
    assert.equal((await observer.query('select status from plan_proposals where id=$1',[f.proposal])).rows[0].status,'open');
    assert.equal((await observer.query('select count(*)::int as n from trip_suggestions where trip_id=$1',[f.trip])).rows[0].n,0);
  } finally {
    await writer.query('rollback');
    if(pending) await pending;
  }
});

test('removal retries a connection inserted while waiting for the trip without locking it in reverse order', async () => {
  const f=await fixture();
  await writer.query('delete from trip_agent_connections where trip_id=$1',[f.trip]);
  let pending;
  await writer.query('begin');
  try {
    await writer.query(`insert into trip_agent_connections(trip_id,provider,status,credential_digest)
      values($1,'openclaw','active',$2)`,[f.trip,randomUUID().replaceAll('-','').repeat(2)]);
    pending=settler.query('select remove_trip_traveler_guarded($1,$2,$3) as result',[f.trip,f.humans[0],f.humans[1]])
      .then(value=>({value}),error=>({error}));
    await waitForBlocked();
    await writer.query('commit');
    assert.equal((await pending).error?.code,'TP009');
    assert.equal((await observer.query('select id from travelers where id=$1',[f.humans[1]])).rowCount,1);
    const retried=await settler.query('select remove_trip_traveler_guarded($1,$2,$3) as result',[f.trip,f.humans[0],f.humans[1]]);
    assert.equal(retried.rows[0].result,'removed');
  } finally {
    await writer.query('rollback');
    if(pending) await pending;
  }
});
