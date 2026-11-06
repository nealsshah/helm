import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const usage =
  "node tools/helm/firstmate.mjs --firstmate <installation> --home <instance> --task <task-id> --item <work-item-id> [--watch]";

async function regularFile(file) {
  const stat = await NodeFSP.lstat(file);
  if (!stat.isFile()) throw new Error(`Expected a regular file at ${file}.`);
  return stat;
}

async function readLegacyReport({ firstmate, home, task, item }) {
  const base = NodePath.resolve(home, "state", task);
  await regularFile(`${base}.meta`);
  const meta = new Map();
  for (const line of (await NodeFSP.readFile(`${base}.meta`, "utf8")).split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const key = line.slice(0, i);
    if (!["backend", "endpoint_task_id", "t3_thread_id"].includes(key)) continue;
    const value = line.slice(i + 1);
    if (meta.has(key) && meta.get(key) !== value) throw new Error(`Conflicting ${key} bindings.`);
    meta.set(key, value);
  }
  const threadId = meta.get("t3_thread_id");
  if (!threadId || meta.get("backend") !== "t3code" || meta.get("endpoint_task_id") !== task) {
    throw new Error(`Task ${task} has no matching T3 Code endpoint binding.`);
  }
  const status = `${base}.status`;
  const stat = await regularFile(status);
  // First Mate owns the keyed open-decision fold. Its non-incremental reader leaves its cursor alone.
  const { stdout } = await exec("bash", [
    "-c",
    'source "$1" && { tail -n 1 "$2"; printf "\\n"; status_open_decisions "$2"; }',
    "helm-firstmate",
    NodePath.resolve(firstmate, "bin/fm-classify-lib.sh"),
    status,
  ]);
  const [latest, ...open] = stdout.trimEnd().split("\n");
  const decisions = open.filter(Boolean).map((row) => {
    const [key, verb, ...note] = row.split("\t");
    return `[${key}] ${verb}: ${note.join(" ")}`;
  });
  const text = [latest, ...(decisions.length ? ["Open in First Mate:", ...decisions] : [])]
    .filter(Boolean)
    .join("\n");
  return text
    ? {
        type: "report",
        itemId: item,
        threadId,
        format: "legacy",
        text,
        reportedAt: stat.mtime.toISOString(),
      }
    : null;
}

async function mirror(args) {
  const { firstmate, home, task, item } = args;
  const adapter = await import(
    NodeURL.pathToFileURL(NodePath.resolve(firstmate, "bin/fm-t3-mcp.mjs")).href
  );
  const credential = adapter.readCredential(NodePath.resolve(home, "config/t3code-token"));
  const session = new adapter.McpSession(credential.origin, credential.access_token);
  try {
    const server = await adapter.gate(session, credential);
    if (!server.tools.includes("t3_workspace_update"))
      throw new Error("This T3 server does not offer Helm workspace tools.");
    const { items } = await session.call("t3_workspace_read", { itemId: item });
    if (!items.length) throw new Error(`Create or select work item ${item} first.`);
    let previous = items[0].latestReport;
    let observedStatus;
    do {
      const base = NodePath.resolve(home, "state", task);
      const [meta, status] = await Promise.all([
        regularFile(`${base}.meta`),
        regularFile(`${base}.status`),
      ]);
      const version = [meta, status].map((s) => `${s.ino}:${s.size}:${s.mtimeMs}`).join("/");
      if (observedStatus !== version) {
        const command = await readLegacyReport(args);
        if (
          command &&
          !(
            previous?.threadId === command.threadId &&
            previous.format === "legacy" &&
            previous.reportedAt === command.reportedAt &&
            previous.text === command.text
          )
        ) {
          await session.call("t3_workspace_update", { command });
          process.stdout.write(`Mirrored ${task} to ${item} at ${command.reportedAt}.\n`);
          previous = command;
        }
        observedStatus = version;
      }
      if (args.watch) await NodeTimersPromises.setTimeout(2000);
    } while (args.watch);
  } finally {
    await session.close();
  }
}

export async function watchWithReconnect(run, wait, emit) {
  let delayMs = 1000;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      const retryable = ["transport", "ETIMEDOUT", "ECONNRESET", "EAGAIN", "ESTALE"].includes(
        error.code ?? error.cause?.code,
      );
      if (!retryable) throw error;
      emit(`First Mate sync paused: ${error.message}. Retrying in ${delayMs / 1000}s.\n`);
      await wait(delayMs);
      delayMs = Math.min(30000, delayMs * 2);
    }
  }
}

if (import.meta.main) {
  try {
    const { values } = NodeUtil.parseArgs({
      options: {
        firstmate: { type: "string" },
        home: { type: "string" },
        task: { type: "string" },
        item: { type: "string" },
        watch: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
    if (values.help) process.stdout.write(`${usage}\n`);
    else {
      if (
        !values.firstmate ||
        !values.home ||
        !values.item ||
        !/^[\w-][\w.-]*$/.test(values.task ?? "")
      )
        throw new Error(usage);
      if (values.watch) {
        await watchWithReconnect(
          () => mirror(values),
          NodeTimersPromises.setTimeout,
          (message) => process.stderr.write(message),
        );
      } else {
        await mirror(values);
      }
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
