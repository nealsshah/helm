# Direct work through the workspace

Open **Workspace → First Mate** to start a task. Describe the outcome you want. To start work in another registered project on the same environment, name it in your request. The Second Mate starts in that project. The First Mate creates a card and sends the brief to that task’s **Second Mate**. Use the project name in a chat header to move an idle conversation to another project. The chat keeps its history and the next turn runs in the selected project’s folder. Use **+** to open a First Mate draft. Choose its project above the composer and send your first message to start the session.

Open a task card to speak directly to its Second Mate. Give it another instruction while a worker is busy, such as asking for an independent review. The Second Mate can dispatch another worker and report back in the same chat. The Second Mate keeps routine worker exchanges out of your conversation. To inspect them, open the task’s **Workers** menu and choose **Show worker activity**, or select a worker to read its own conversation. Existing tasks keep their original work history there.

The card’s stage follows the task as a whole. **Planning** covers scope and design, **Building** covers implementation and fixes, **Reviewing** covers inspecting changes, and **QA** covers trying the running feature. A task can skip a stage or return to an earlier one. The Second Mate marks the task **Done** when the requested work is verified.

Workers bring questions to the Second Mate first. If the task already gives it enough direction, the Second Mate answers the worker. When it needs your decision, the task appears in **Needs me**. Open the card and reply to the Second Mate. It passes your answer to the worker. Provider permission approvals still open in the session requesting permission.

When the Second Mate finishes answering your message, the task appears in **Needs me** with **Reply ready**. Open the card to read the answer and clear the notification. A decision still waiting on you stays in **Needs me** until you answer it.

Retire a task to remove its card from the board and settle its Second Mate and workers. Click the checkmark on a Done card. For an unfinished task, right-click or double-click the card, choose **Retire task**, and confirm. **Retired tasks** lets you restore a card to its previous stage.

## Mirror a task from the external First Mate tool

Helm’s First Mate chat runs inside Helm. The optional bridge below is for tasks already managed by a separate installation of First Mate.

For a task using First Mate's T3 backend, first associate the thread recorded in its task metadata with a work item on the same Helm environment. Run the following from the Helm checkout, replacing the paths and identifiers with yours.

```sh
node tools/helm/firstmate.mjs --firstmate /path/to/firstmate --home /path/to/instance \
  --task task-id --item work-item-id --watch
```

The bridge uses the installed First Mate adapter and its existing sign-in. It verifies the environment, reads the selected task's binding, and publishes the latest status line and outstanding keyed decisions as a legacy report. Omitting `--watch` runs one sync. The watcher reconnects after temporary transport failures and reconciles the current status. An authentication or binding error stops it and prints the reason.

Answer legacy decisions through First Mate so its supervisor records the resolution. First Mate's separate supervisor can still send its own notifications for legacy tasks.
