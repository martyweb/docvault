import { useEffect, useState } from "react";

export interface Route {
  path: string[];
  params: URLSearchParams;
}

function parse(): Route {
  const [path, query = ""] = window.location.hash.replace(/^#\/?/, "").split("?");
  return { path: path.split("/").filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(query) };
}

/** Minimal hash router: #/search?q=x -> { path: ["search"], params: q=x } */
export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function docHref(id: string, opts: { page?: number | null; q?: string } = {}) {
  const params = new URLSearchParams();
  if (opts.page) params.set("page", String(opts.page));
  if (opts.q) params.set("q", opts.q);
  const qs = params.toString();
  return `#/doc/${id}${qs ? `?${qs}` : ""}`;
}
