# Helm

Helm is a fork of [T3 Code](https://github.com/pingdotgg/t3code) for running several coding tasks at once. Each task has a card on the workspace board and a chat with the agent coordinating its workers. You can see what's in review, answer a question, or start another task while the others run.

## Get started on a Mac

1. Install and sign in to a coding agent on your Mac, such as Codex CLI (`codex login`) or Claude Code (`claude auth login`).
2. On an Apple silicon Mac, download the arm64 ZIP from the [latest Helm release](https://github.com/nealsshah/helm/releases/latest). Unzip it, move **Helm.app** into your Applications folder, and open it. These builds use a local signing certificate. If macOS blocks the app, you can run Helm from source using the steps below.
3. Add your project folder. Open **Workspace → First Mate** and describe a task. First Mate creates a card for it. Open the card to talk to its **Second Mate**, the agent that coordinates that task's workers.
4. Check **Needs me** for questions and replies. Open a card to read the conversation or answer the question.

The desktop app stores its data in `~/.helm`. For more on working with several projects and inspecting individual workers, see the [workspace guide](./docs/user/workspace-agents.md).

## Run from source

Install Node.js 26.12.1 and pnpm 12.14.0, then run these commands in a terminal.

```sh
git clone https://github.com/nealsshah/helm.git
cd helm
pnpm install --frozen-lockfile
T3CODE_DEV_SEED=0 pnpm dev --home-dir "$PWD/.t3"
```

Open the pairing URL printed in the terminal. This starts the web app with its own local data directory. In builds that label the coordinator **Orchestrator**, open **Workspace → Orchestrator** to start a task.
