import type { Metadata } from "next";
import ResumeClient from "./ResumeClient";

/** Never indexed: the URL carries a traveller's access token. */
export const metadata: Metadata = {
  title: "Signing in…",
  robots: { index: false, follow: false },
};

export default async function ResumePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ResumeClient slug={slug} />;
}
