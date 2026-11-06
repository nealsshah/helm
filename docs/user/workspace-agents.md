# Direct work through the workspace

Open **Workspace → Orchestrator** and describe the work. Use **+** above the conversation to start another orchestrator. Each tab has its own conversation and can coordinate the same environment’s board. Closing a tab ends its orchestrator role. Its conversation remains in the sidebar. Managing work items requires full access and default interaction mode.

Give each worker its item ID. A worker can call `t3_workspace_read` to find its assigned item and `callerThreadId`. It sends a `report` with that thread ID and the new `stage` when it starts planning, building, testing or completes the deliverable.

When a worker needs your attention, it explains why in chat and sends a report with `needsAttention: true`. Its session appears in **Needs me** above the board. Open the card and reply directly. Provider approvals use the controls inside the conversation. Once all attention on the ticket clears, it returns to its current stage.

## Mirror an existing First Mate task

For a task using First Mate's T3 backend, first associate the thread recorded in its task metadata with a work item on the same Helm environment. Run the following from the Helm checkout, replacing the paths and identifiers with yours.

```sh
node tools/helm/firstmate.mjs --firstmate /path/to/firstmate --home /path/to/instance \
  --task task-id --item work-item-id --watch
```

The bridge uses the installed First Mate adapter and its existing sign-in. It verifies the environment, reads the selected task's binding, and publishes the latest status line and outstanding keyed decisions as a legacy report. Omitting `--watch` runs one sync. The watcher reconnects after temporary transport failures and reconciles the current status. An authentication or binding error stops it and prints the reason.

Answer legacy decisions through First Mate so its supervisor records the resolution. First Mate's separate supervisor can still send its own notifications for legacy tasks.
