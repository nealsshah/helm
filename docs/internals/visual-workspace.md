# Work item identity and reply delivery

Helm builds on T3 Nightly `v0.1.8-nightly.20261105.4234`. T3 owns threads, provider sessions, runtime requests and message history. A Helm item owns the deliverable. It can keep a decision, dependency or artifact when a worker is replaced. Explicit workspace commands change its stage. Finishing a provider turn only changes the observed runtime.

## Answering a worker

Workers flag their own sessions through progress reports. The attention card opens the source chat, where the user can send an ordinary message. Native provider approvals retain their provider request identity and authorization checks.

Older clients can still deliver a structured workspace reply. When a person submits an answer, the owning server reserves a delivery ID on the request in a transaction. It sends the reply to the stored source thread with that ID as both the T3 command identity and message identity. Concurrent clients cannot replace the reserved answer. A retry of an uncertain delivery reuses its identity. After a restart the server can confirm acceptance from the durable user message even after old command receipts have been pruned. The run’s subsequent state and the worker’s acknowledgment provide separate evidence of execution. See [workspace delivery](../../apps/server/src/workspace/VisualWorkspace.ts) and its [integration tests](../../apps/server/src/workspace/VisualWorkspace.test.ts).

## Connecting First Mate

The First Mate adapter inspected at revision `d56926d88318873c22ddfa9d57d4c11fa7d953d8` records a task ID separately from its T3 thread ID. The optional bridge resolves that binding through the installed adapter and publishes activity to an associated item. Legacy decisions keep their First Mate destination. See [Direct work through the workspace](../user/workspace-agents.md).

A server advertises `visualWorkspace` before a client subscribes to its durable work items. Older environments can still supply native session summaries. Workspace commands require a Helm-capable server. The desktop app uses a separate Electron profile and T3 home so installing the fork cannot take ownership of sessions running in another installation.
