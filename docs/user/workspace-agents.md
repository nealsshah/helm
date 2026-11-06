# Direct work through the workspace

Open **Workspace**, choose the conversation you want to use for global direction, and give it a deliverable. A full-access orchestrator in default mode can create work items, set priorities, record decisions, attach evidence, identify dependencies and associate existing worker threads. A worker can read its assigned items, move its own card as work progresses and ask a person for input. These tools run on the environment that owns the threads.

Ask the orchestrator to put the item ID in each worker's brief. A worker can call `t3_workspace_read` to find its item and `callerThreadId`. Use that thread ID in `t3_workspace_update`. When work changes phase, include the new `stage` in a `report` command. Workers use **Planning** to scope the work, **Building** to implement or fix it, **QA** to test or review it, and **Done** when the deliverable is verified and complete. For progress within the current phase, send the report with just its text, item ID and thread ID. For a decision, include the exact question and reuse the same request ID on retries.

```json
{
  "command": {
    "type": "request",
    "itemId": "import-preview",
    "threadId": "qa-worker-thread-id",
    "requestId": "import-preview:invalid-rows",
    "kind": "question",
    "prompt": "Should importing stop at the first invalid row?",
    "context": "Skipping invalid rows lets valid rows import. Stopping keeps the batch together.",
    "choices": ["Stop the import", "Skip invalid rows"]
  }
}
```

The tool returns the persisted request, including its status and any accepted response. A new question needs a new request ID, even if it repeats an earlier question. A ticket with open requests appears in the **Needs me** list above the board. Select a question or approval there to address it. Once the last request clears, the card returns to its current work stage. A worker that reports the item complete moves its card to **Done**. An accepted reply goes to the source conversation. Provider approvals use the existing T3 controls. A fully authorized external MCP client can manage the board and publish on behalf of an associated thread. See [Connect an outside agent](outside-agents.md).

## Mirror an existing First Mate task

For a task using First Mate's T3 backend, first associate the thread recorded in its task metadata with a work item on the same Helm environment. Run the following from the Helm checkout, replacing the paths and identifiers with yours.

```sh
node tools/helm/firstmate.mjs --firstmate /path/to/firstmate --home /path/to/instance \
  --task task-id --item work-item-id --watch
```

The bridge uses the installed First Mate adapter and its existing sign-in. It verifies the environment, reads the selected task's binding, and publishes the latest status line and outstanding keyed decisions as a legacy report. Omitting `--watch` runs one sync. The watcher reconnects after temporary transport failures and reconciles the current status. An authentication or binding error stops it and prints the reason.

Answer legacy decisions through First Mate so its supervisor records the resolution. New workers can use the workspace request shown above to receive direct answers. First Mate's separate supervisor can still send its own notifications for legacy tasks.
