export async function broadcastTripUpdate(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const res = await fetchImpl(`${process.env.SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      messages: [{ topic: `trip:${slug}`, event: "updated", payload: {}, private: false }],
    }),
  });
  if (!res.ok) throw new Error(`broadcast failed: ${res.status}`);
}
