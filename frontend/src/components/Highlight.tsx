import { Fragment, ReactNode } from "react";

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Words from a search query worth highlighting (drops quotes, operators, 1-letter words). */
export function queryTerms(q: string): string[] {
  return [...new Set(q.toLowerCase().replace(/["()]/g, " ").split(/\s+/))].filter(
    (t) => t.length > 1 && t !== "or" && !t.startsWith("-"),
  );
}

/** Wraps case-insensitive matches of `terms` in <mark>. */
export function Highlight({ text, terms }: { text: string; terms: string[] }): ReactNode {
  if (!terms.length) return text;
  const re = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}

/** Renders a server snippet whose matches are wrapped in start/end markers. */
export function MarkedSnippet({ text, markers }: { text: string; markers: [string, string] }) {
  const [start, end] = markers;
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  for (;;) {
    const s = rest.indexOf(start);
    if (s === -1) break;
    const e = rest.indexOf(end, s + start.length);
    if (e === -1) break;
    out.push(rest.slice(0, s), <mark key={key++}>{rest.slice(s + start.length, e)}</mark>);
    rest = rest.slice(e + end.length);
  }
  out.push(rest);
  return <>{out}</>;
}
