import { commitHrefOf, type CommitSource } from '@/lib/commit';

/** `atelier/blog@main · 3f2a9c1` — repository, branch, exact commit, clickable at its forge. */
export function CommitRef({ source }: { source: CommitSource }) {
  return (
    <span className="mono inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <span className="truncate">
        {source.repository}
        {source.ref ? <span className="text-text-3">@{source.ref}</span> : null}
      </span>
      <a href={commitHrefOf(source)} target="_blank" rel="noreferrer" className="link">
        {source.sha.slice(0, 7)}
      </a>
    </span>
  );
}
