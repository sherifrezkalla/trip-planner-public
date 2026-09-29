import { z } from "zod";
import { serviceClient } from "@/lib/db";
import { authTraveler, TRIP_TOKEN_HEADER } from "@/lib/auth";
import { confirmTripAgentAction } from "@/lib/trip-agent-confirmation";

const bodySchema = z.object({ decision: z.enum(["confirm", "reject"]) }).strict();
function failure(code: string, status: number) {
  return Response.json({ error: { code } }, { status, headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; actionId: string }> }) {
  try {
    const { slug, actionId } = await params;
    const token = request.headers.get(TRIP_TOKEN_HEADER)?.trim();
    if (!token) return failure("unauthorized", 401);
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success || !z.string().uuid().safeParse(actionId).success) return failure("invalid_input", 400);
    const db = serviceClient();
    const auth = await authTraveler(db, slug, token);
    if ("error" in auth) return failure(auth.status === 503 ? "database_unavailable" : auth.status === 404 ? "trip_not_found" : "unauthorized", auth.status);
    if (!auth.me.is_organizer || auth.me.is_bot) return failure("organizer_required", 403);
    const result = await confirmTripAgentAction(db, { tripId: auth.trip.id, actorId: auth.me.id, actionId, decision: body.data.decision });
    if ("code" in result) return failure(result.code, result.code === "database_unavailable" ? 503 : result.code === "action_not_found" ? 404 : result.code === "organizer_required" ? 403 : result.code === "invalid_input" ? 400 : 409);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch { return failure("database_unavailable", 503); }
}
