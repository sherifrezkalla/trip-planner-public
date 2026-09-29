import type { Metadata } from "next";
import TripBoard from "@/components/TripBoard";
import { serviceClient } from "@/lib/db";
import { dayCount } from "@/lib/auth";
import { formatTripDateRange } from "@/lib/trip-dates";

/**
 * Makes a shared link render as a card in WhatsApp, Telegram and iMessage.
 *
 * Carries only the title, destination and dates — never traveller names, since a
 * card travels further than the link itself. The page is noindex: the slug is
 * the trip's only secret, and being pleasantly shareable is exactly what would
 * otherwise attract a crawler.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const { data: trip } = await serviceClient()
    .from("trips")
    .select("title, destination_name, start_date, end_date")
    .eq("slug", slug)
    .single();

  if (!trip) {
    return { title: "Trip Planner", robots: { index: false, follow: false } };
  }

  const title = (trip.title as string) || (trip.destination_name as string);
  const days = dayCount(trip.start_date as string, trip.end_date as string);
  const description = `${formatTripDateRange(trip.start_date as string, trip.end_date as string)} · ${days} days in ${trip.destination_name}`;
  const image = `/api/trips/${slug}/photo`;

  // Without this, Next resolves the image against whichever alias served the
  // request, so a card could pull its photo from a different domain than the
  // link that was shared.
  const site =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined);

  return {
    ...(site ? { metadataBase: new URL(site) } : {}),
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, images: [image], type: "website" },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function TripPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <TripBoard slug={slug} />;
}
