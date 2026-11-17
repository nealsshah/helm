import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { WorkItem } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export interface WorkPanelLink {
  readonly url: string;
  readonly label: string;
}

function serviceLink(
  value: string,
  label?: string,
): (WorkPanelLink & { readonly service: "linear" | "github" }) | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  const issue = /^\/([^/]+)\/issue\/([a-z]+-\d+)(?:\/[^/]*)?\/?$/i.exec(url.pathname);
  if (url.hostname === "linear.app" && issue) {
    const key = issue[2]!.toUpperCase();
    return {
      service: "linear",
      url: `https://linear.app/${issue[1]}/issue/${key}`,
      label: label && !label.toUpperCase().startsWith(key) ? `${key} · ${label}` : label || key,
    };
  }
  const pr = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i.exec(url.pathname);
  if (url.hostname === "github.com" && pr) {
    const reference = `${pr[1]}/${pr[2]}#${Number(pr[3])}`;
    return {
      service: "github",
      url: `https://github.com/${pr[1]!.toLowerCase()}/${pr[2]!.toLowerCase()}/pull/${Number(pr[3])}`,
      label: label ? `${reference} · ${label}` : reference,
    };
  }
  return undefined;
}

export function workPanelLinks({
  item,
  shells,
}: {
  item: Pick<WorkItem, "scope" | "artifacts"> | undefined;
  shells: ReadonlyArray<
    Pick<EnvironmentThreadShell, "pullRequests" | "linkedPullRequest" | "branchPullRequest">
  >;
}) {
  const linear = new Map<string, WorkPanelLink>();
  const github = new Map<string, WorkPanelLink>();
  const add = (value: string, label?: string) => {
    const link = serviceLink(value, label);
    if (!link) return false;
    const links = link.service === "linear" ? linear : github;
    if (!links.has(link.url) || (label && !links.get(link.url)?.label.includes(" · ")))
      links.set(link.url, { url: link.url, label: link.label });
    return true;
  };
  for (const shell of shells) {
    for (const link of visibleThreadPullRequests(shell.pullRequests))
      add(link.url, link.snapshot?.title);
    for (const link of [
      ...(shell.pullRequests.length === 0 ? [shell.linkedPullRequest] : []),
      shell.branchPullRequest,
    ]) {
      if (
        link &&
        !shell.pullRequests.some(
          (entry) =>
            entry.source === "stack-dismissed" &&
            serviceLink(entry.url)?.url === serviceLink(link.url)?.url,
        )
      )
        add(link.url);
    }
  }
  const artifacts = (item?.artifacts ?? []).filter(
    (artifact) => !add(artifact.url, artifact.label),
  );
  for (const match of item?.scope.matchAll(/https:\/\/linear\.app\/[^\s<>"'\])}]+/gi) ?? []) {
    const value = match[0].replace(/[.,;:!?]+$/, "");
    const link = serviceLink(value);
    if (link?.service === "linear") add(value);
  }
  return { linear: [...linear.values()], github: [...github.values()], artifacts };
}
