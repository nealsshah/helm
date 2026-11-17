import { ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { workPanelLinks } from "./workPanelLinks";

it("groups associated issue and PR links and keeps other artifacts accessible", () => {
  const pr = {
    projectId: ProjectId.make("meow"),
    repository: "acme/app",
    host: "github.com",
    number: 12,
    url: "https://github.com/Acme/App/pull/12?tab=checks",
  };
  const links = workPanelLinks({
    item: {
      scope:
        "Implement https://linear.app/acme/issue/ACME-123/title. Project https://linear.app/acme/project/roadmap. Also https://linear.app/acme/issue/acme-456/next",
      artifacts: [
        { label: "Fix checkout", url: "https://linear.app/acme/issue/acme-123/title#details" },
        { label: "Fix payment", url: "https://github.com/acme/app/pull/12" },
        { label: "Preview", url: "https://preview.example.com" },
        { label: "Unsafe", url: "javascript:alert(1)" },
      ],
    },
    shells: [
      {
        pullRequests: [
          { ...pr, source: "agent", linkedAt: "2026-11-17T00:00:00Z", snapshot: null, stack: null },
        ],
        linkedPullRequest: pr,
        branchPullRequest: pr,
      },
      { pullRequests: [], linkedPullRequest: pr, branchPullRequest: null },
    ],
  });
  expect(links.linear).toEqual([
    { url: "https://linear.app/acme/issue/ACME-123", label: "ACME-123 · Fix checkout" },
    { url: "https://linear.app/acme/issue/ACME-456", label: "ACME-456" },
  ]);
  expect(links.github).toEqual([
    { url: "https://github.com/acme/app/pull/12", label: "acme/app#12 · Fix payment" },
  ]);
  expect(links.artifacts.map((artifact) => artifact.label)).toEqual(["Preview", "Unsafe"]);
});

it("does not restore dismissed PRs through legacy or branch links", () => {
  const pr = {
    projectId: ProjectId.make("meow"),
    repository: "acme/app",
    host: "github.com",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
  };
  expect(
    workPanelLinks({
      item: undefined,
      shells: [
        {
          linkedPullRequest: pr,
          branchPullRequest: pr,
          pullRequests: [
            {
              ...pr,
              source: "stack-dismissed",
              linkedAt: "2026-11-17T00:00:00Z",
              snapshot: null,
              stack: null,
            },
          ],
        },
      ],
    }).github,
  ).toEqual([]);
});
