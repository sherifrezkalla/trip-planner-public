/**
 * Moving a traveller's identity to another device.
 *
 * The token stored at localStorage["tp:{slug}"] already *is* who you are; it
 * simply cannot travel. A re-attach link carries it to another device, where the
 * resume page validates it before storing anything.
 *
 * This link is a bearer credential for one traveller on one trip — never the
 * link you share with the group.
 */

export const RESUME_PARAM = "k";

/**
 * The token rides in the URL fragment, not the query string.
 *
 * A fragment is the one part of a URL a browser never sends to the server. The
 * request line for a resume link is just `GET /t/{slug}/resume`, so the token
 * appears in no access log, no proxy log, and nothing downstream of them —
 * while still surviving being pasted, messaged, or opened on another device,
 * which is the entire point of the link.
 *
 * The query form used to be `?k=`, and that is why `parseResumeToken` still
 * reads it: links already sent to people are out there and have to keep working.
 * Those links do reach the server with the token attached; nothing here can
 * change that after the fact, only stop minting more of them.
 */
export function buildResumeUrl(origin: string, slug: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/t/${slug}/resume#${RESUME_PARAM}=${encodeURIComponent(token)}`;
}

function tokenFrom(params: URLSearchParams): string | null {
  const trimmed = params.get(RESUME_PARAM)?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * The token from a resume URL, fragment first.
 *
 * Both halves of `window.location` are read because a link minted before the
 * move to fragments carries it in the query string instead. Fragment wins when
 * somehow both are present: it is the form that did not leak.
 */
export function parseResumeToken(search: string, hash = ""): string | null {
  return tokenFrom(new URLSearchParams(hash.replace(/^#/, "")))
    ?? tokenFrom(new URLSearchParams(search));
}
