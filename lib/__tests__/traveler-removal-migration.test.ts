import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

let db: PGlite;
let trip: string, otherTrip: string, actor: string, target: string, outsider: string;
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema storage; create table storage.buckets(id text primary key,name text not null,
    public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);`);
  for (const file of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  [trip, otherTrip, actor, target, outsider] = Array.from({ length: 5 }, () => randomUUID());
  for (const id of [trip, otherTrip]) await db.query(`insert into trips(id,slug,destination_name,destination_place_id,lat,lng,start_date,end_date,budget_level)
    values($1::uuid,$1::text,'Test','test',1,1,'2099-01-01','2099-01-07','mid')`, [id]);
  for (const [id, tripId, organizer] of [[actor, trip, true], [target, trip, false], [outsider, otherTrip, true]]) {
    await db.query(`insert into travelers(id,trip_id,display_name,token,interests,pace,dietary,is_organizer)
      values($1::uuid,$2,'Test',$1::text,array['art'],'balanced','none',$3)`, [id, tripId, organizer]);
  }
});
async function remove(actorId = actor, targetId = target) {
  return (await db.query<{ result: string }>("select remove_trip_traveler_guarded($1,$2,$3) as result", [trip, actorId, targetId])).rows[0].result;
}
describe("traveler removal database boundary", () => {
  it("removes a traveler and their vote without requiring an agent connection", async () => {
    const proposal = (await db.query<{ id: string }>("select create_suggestion_proposal($1,$2,'Museum') as id", [trip, actor])).rows[0].id;
    await db.query("insert into plan_proposal_votes(proposal_id,traveler_id,value) values($1,$2,-1)", [proposal, target]);
    expect(await remove()).toBe("removed");
    expect((await db.query("select id from travelers where id=$1", [target])).rows).toEqual([]);
    expect((await db.query("select id from plan_proposal_votes where traveler_id=$1", [target])).rows).toEqual([]);
    expect(await remove()).toBe("not_found");
  });
  it("removes confirmed mappings through the normal foreign-key cascade", async () => {
    const connection = (await db.query<{ id: string }>("insert into trip_agent_connections(trip_id,provider,status,credential_digest) values($1,'openclaw','active',$2) returning id", [trip, randomUUID().replaceAll("-", "").repeat(2)])).rows[0].id;
    await db.query(`insert into trip_agent_participant_mappings(connection_id,external_participant_digest,traveler_id,status,confirmed_by,confirmed_at)
      values($1,$2,$3,'confirmed',$4,now())`, [connection, "e".repeat(64), target, actor]);
    expect(await remove()).toBe("removed");
    expect((await db.query("select id from trip_agent_participant_mappings where connection_id=$1", [connection])).rows).toEqual([]);
  });
  it.each(["demoted", "bot"])("revalidates a %s organizer", async state => {
    await db.query(state === "demoted" ? "update travelers set is_organizer=false where id=$1" : "update travelers set is_bot=true where id=$1", [actor]);
    expect(await remove()).toBe("forbidden");
    expect((await db.query("select id from travelers where id=$1", [target])).rows).toHaveLength(1);
  });
  it("rejects self-removal and cross-trip actor/target IDs", async () => {
    expect(await remove(actor, actor)).toBe("self_removal");
    expect(await remove(outsider)).toBe("forbidden");
    expect(await remove(actor, outsider)).toBe("not_found");
    expect((await db.query("select id from travelers where id=$1", [outsider])).rows).toHaveLength(1);
  });
  it("restricts execution to the service role", async () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      const result = await db.query<{ allowed: boolean }>("select has_function_privilege($1,'remove_trip_traveler_guarded(uuid,uuid,uuid)','EXECUTE') as allowed", [role]);
      expect(result.rows[0].allowed).toBe(role === "service_role");
    }
  });
});
