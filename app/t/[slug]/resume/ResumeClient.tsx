"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TRIP_TOKEN_HEADER } from "@/lib/auth";
import { parseResumeToken } from "@/lib/resume";

type State = { kind: "checking" } | { kind: "error"; message: string; canJoin: boolean };

/**
 * Turns a re-attach link into an identity on this device.
 *
 * The token is stored only after the board accepts it, so a stale link can
 * never leave a device half-attached. The URL is then replaced rather than
 * pushed, keeping the token out of the address bar and off the back button.
 */
export default function ResumeClient({ slug }: { slug: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "checking" });

  useEffect(() => {
    const token = parseResumeToken(window.location.search, window.location.hash);
    let cancelled = false;
    (async () => {
      // Keep state transitions asynchronous so the effect remains an external-system sync.
      await Promise.resolve();
      if (cancelled) return;
      if (!token) {
        setState({ kind: "error", message: "This link is missing its access code.", canJoin: true });
        return;
      }
      try {
        const res = await fetch(`/api/trips/${slug}`, {
          headers: { [TRIP_TOKEN_HEADER]: token },
        });
        if (cancelled) return;

        if (res.ok) {
          localStorage.setItem(`tp:${slug}`, token);
          router.replace(`/t/${slug}`);
          return;
        }
        if (res.status === 401) {
          setState({
            kind: "error",
            message: "This link is no longer valid — the traveller it belonged to may have been removed.",
            canJoin: true,
          });
          return;
        }
        if (res.status === 404) {
          setState({ kind: "error", message: "This trip doesn't exist any more.", canJoin: false });
          return;
        }
        setState({ kind: "error", message: `Couldn't check this link (error ${res.status}).`, canJoin: false });
      } catch {
        if (!cancelled) {
          setState({ kind: "error", message: "Couldn't reach the server. Check your connection.", canJoin: false });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [slug, router]);

  if (state.kind === "checking") {
    return <p className="p-6 text-[#8A8272]">Signing you in on this device…</p>;
  }

  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-8 text-center shadow-sm">
      <h1 className="font-display text-2xl text-[#2D2A24]">Can&apos;t use this link</h1>
      <p className="mt-3 text-[#8A8272]">{state.message}</p>
      {state.canJoin && (
        <button
          onClick={() => router.replace(`/t/${slug}`)}
          className="mt-6 rounded-full bg-[#C2571B] px-5 py-2.5 font-semibold text-white transition hover:bg-[#A84A15]"
        >
          Open the trip and join
        </button>
      )}
    </div>
  );
}
