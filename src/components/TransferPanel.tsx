"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { api } from "../../convex/_generated/api";
import { evaluateProgram } from "@/lib/engine";
import { dateKey, type Evaluation, type Files, type LogEntry } from "@/lib/runtime";
import {
  backupFilename,
  buildBackup,
  buildSnapshot,
  openBackup,
  planImport,
  planPush,
  type ImportPlan,
  type RemoteSnapshot,
  type Snapshot,
} from "@/lib/todosst";

// Direct two-way sync with a todosst account (with backup-file transfer kept
// as an offline fallback). See convex/todosstSync.ts and src/lib/todosst.ts.

const LOG_BATCH = 400;

const input = "w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-accent";
const primary = "rounded-lg bg-ink text-bg px-3 py-2 text-sm font-medium disabled:opacity-50";
const secondary = "rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink hover:border-muted disabled:opacity-50";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function importSummary(plan: ImportPlan): string {
  const files = plan.changes.filter((c) => c.source !== null).length;
  const parts = [`${plan.tasks} tasks into ${plural(files, "file")} under todosst/`];
  if (plan.kept) parts.push(`${plan.kept} already defined in your own files (kept as they are)`);
  parts.push(`${plan.log.length} history entries`);
  return parts.join(", ") + ".";
}

function skippedNote(plan: ImportPlan): string | null {
  const s = plan.skipped;
  const bits = [
    s.completed && `${plural(s.completed, "completed one-off task")}`,
    s.avoid && `${plural(s.avoid, "avoid (negative) task")}`,
    s.habit && `the "open todosst" habit`,
  ].filter(Boolean);
  return bits.length ? `Left in todosst only: ${bits.join(", ")}.` : null;
}

function formatSyncTime(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function applyFileChanges(files: Files, changes: { path: string; source: string | null }[]): Files {
  const next: Files = { ...files };
  for (const c of changes) {
    if (c.source === null) delete next[c.path];
    else next[c.path] = c.source;
  }
  return next;
}

function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Convex wraps ConvexError messages with "Uncaught ConvexError: ..."
  return raw.replace(/^[\s\S]*?ConvexError:\s*/i, "").trim() || raw;
}

export function TransferPanel({
  files,
  log,
  evaluation,
  onClose,
}: {
  files: Files | undefined;
  log: LogEntry[];
  evaluation: Evaluation | null;
  onClose: () => void;
}) {
  const connection = useQuery(api.todosstSync.status);
  const connectAction = useAction(api.todosstSync.connect);
  const disconnectAction = useAction(api.todosstSync.disconnect);
  const pullRemote = useAction(api.todosstSync.pullRemote);
  const applyRemote = useAction(api.todosstSync.applyRemote);
  const recordSync = useMutation(api.todosstSync.recordSync);

  const post = useMutation(api.program.post);
  const importTotals = useMutation(api.log.importTotals);

  // Direct sync state
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [syncBusy, setSyncBusy] = useState<"connect" | "disconnect" | "both" | "pull" | "push" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Backup file fallback state
  const [file, setFile] = useState<File | null>(null);
  const [inPass, setInPass] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [outPass, setOutPass] = useState("");
  const [outPass2, setOutPass2] = useState("");
  const [fileBusy, setFileBusy] = useState<"read" | "import" | "export" | null>(null);

  const ready = Boolean(files && evaluation);
  const busy = syncBusy !== null || fileBusy !== null;

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!username.trim() || !password) {
      return setMsg({ ok: false, text: "Enter your todosst username and password." });
    }
    setSyncBusy("connect");
    try {
      const res = await connectAction({
        username: username.trim(),
        password,
        url: serverUrl.trim() || undefined,
      });
      setPassword("");
      setMsg({ ok: true, text: `Connected to todosst as @${res.username}. Click "Sync both ways" to sync now.` });
    } catch (err) {
      setMsg({ ok: false, text: cleanError(err) });
    } finally {
      setSyncBusy(null);
    }
  }

  async function handleDisconnect() {
    setMsg(null);
    setSyncBusy("disconnect");
    try {
      await disconnectAction({});
      setMsg({ ok: true, text: "Disconnected from todosst." });
    } catch (err) {
      setMsg({ ok: false, text: cleanError(err) });
    } finally {
      setSyncBusy(null);
    }
  }

  async function runSync(mode: "both" | "pull" | "push") {
    if (!files || !evaluation) return;
    setMsg(null);
    setSyncBusy(mode);
    try {
      const now = Date.now();
      const remote = (await pullRemote({})) as RemoteSnapshot;

      let pulledFileChanges = 0;
      let pulledTasks = 0;
      let pulledLog = 0;
      let skippedText: string | null = null;
      let nextTasks = evaluation.tasks;

      if (mode === "both" || mode === "pull") {
        const snap: Snapshot = {
          v: 1,
          todos: remote.todos.map((t) => ({ id: t.id, node: t.node })),
          history: remote.history.map((h) => ({ todoId: h.todoId, counts: h.counts })),
        };
        const importPlan = planImport(snap, { files, existing: evaluation.tasks, now });
        skippedText = skippedNote(importPlan);

        if (importPlan.changes.length) {
          await post({
            role: "edit",
            text: `Synced ${importPlan.tasks} tasks from todosst.`,
            changes: importPlan.changes,
          });
          pulledFileChanges = importPlan.changes.length;
          pulledTasks = importPlan.tasks;
        }
        for (let i = 0; i < importPlan.log.length; i += LOG_BATCH) {
          pulledLog += await importTotals({ entries: importPlan.log.slice(i, i + LOG_BATCH) });
        }

        if (mode === "both" && importPlan.changes.length) {
          const nextFiles = applyFileChanges(files, importPlan.changes);
          const fresh = await evaluateProgram(nextFiles, log, now, [dateKey(new Date(now))]);
          nextTasks = fresh.tasks;
        }
      }

      let pushedCreated = 0;
      let pushedUpdated = 0;
      let pushedHistories = 0;
      let didRemoteWrite = false;

      if (mode === "both" || mode === "push") {
        const pushPlan = planPush(nextTasks, log, remote, { now });
        pushedCreated = pushPlan.createdTasks;
        pushedUpdated = pushPlan.updatedTasks;
        pushedHistories = pushPlan.updatedHistories;

        const summaryText = buildSyncSummary(mode, {
          pulledFileChanges,
          pulledTasks,
          pulledLog,
          pushedCreated,
          pushedUpdated,
          pushedHistories,
        });

        if (pushPlan.creates.length || pushPlan.updates.length || pushPlan.histories.length) {
          await applyRemote({
            creates: pushPlan.creates.map(({ clientId, parentId, nodeJson }) => ({ clientId, parentId, nodeJson })),
            updates: pushPlan.updates,
            histories: pushPlan.histories,
            summary: summaryText,
          });
          didRemoteWrite = true;
        }
      }

      const summaryText = buildSyncSummary(mode, {
        pulledFileChanges,
        pulledTasks,
        pulledLog,
        pushedCreated,
        pushedUpdated,
        pushedHistories,
      });

      if (!didRemoteWrite) {
        await recordSync({ summary: summaryText });
      }

      const notes: string[] = [summaryText];
      if (skippedText && pulledFileChanges > 0) notes.push(skippedText);
      if ((mode === "both" || mode === "push") && evaluation.errors.length) {
        notes.push(
          `${plural(evaluation.errors.length, "file error")} in your program: tasks in broken files were not pushed.`,
        );
      }
      setMsg({ ok: true, text: notes.join(" ") });
    } catch (err) {
      setMsg({ ok: false, text: cleanError(err) });
    } finally {
      setSyncBusy(null);
    }
  }

  // ---------- backup file fallback handlers ----------

  async function previewFile() {
    setMsg(null);
    setPlan(null);
    if (!file) return setMsg({ ok: false, text: "Choose the backup file you exported from todosst." });
    if (!files || !evaluation) return;
    setFileBusy("read");
    try {
      const snap = await openBackup(await file.text(), inPass);
      setPlan(planImport(snap, { files, existing: evaluation.tasks, now: Date.now() }));
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setFileBusy(null);
    }
  }

  async function runFileImport() {
    if (!plan) return;
    setFileBusy("import");
    setMsg(null);
    try {
      if (plan.changes.length) {
        await post({ role: "edit", text: `Imported ${plan.tasks} tasks from todosst.`, changes: plan.changes });
      }
      let added = 0;
      for (let i = 0; i < plan.log.length; i += LOG_BATCH) {
        added += await importTotals({ entries: plan.log.slice(i, i + LOG_BATCH) });
      }
      setMsg({
        ok: true,
        text: `Done. ${plan.changes.length ? "Your program now has the todosst/ files (undo is in the agent panel)" : "Your program already matched"}; ${added} history entr${added === 1 ? "y" : "ies"} added.`,
      });
      setPlan(null);
      setFile(null);
      setInPass("");
    } catch (e) {
      setMsg({ ok: false, text: `Import stopped: ${e instanceof Error ? e.message : String(e)}. Running it again is safe.` });
    } finally {
      setFileBusy(null);
    }
  }

  async function runFileExport() {
    setMsg(null);
    if (!evaluation) return;
    if (outPass.length < 8) return setMsg({ ok: false, text: "Pick a passphrase of at least 8 characters (todosst asks for it on import)." });
    if (outPass !== outPass2) return setMsg({ ok: false, text: "The passphrases do not match." });
    setFileBusy("export");
    try {
      const snap = buildSnapshot(evaluation.tasks, log);
      const blob = new Blob([await buildBackup(snap, outPass)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = backupFilename();
      a.click();
      URL.revokeObjectURL(url);
      const errs = evaluation.errors.length;
      setMsg({
        ok: true,
        text: `Downloaded ${evaluation.tasks.length} tasks and ${snap.history.length} histories.${errs ? ` ${plural(errs, "file error")} in your program: tasks in a broken file are not included.` : ""}`,
      });
      setOutPass("");
      setOutPass2("");
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setFileBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-bg/90 px-4 py-10" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Sync with todosst"
        className="w-full max-w-lg rounded-xl border border-line bg-bg p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Sync with todosst</h2>
            <p className="mt-1 text-sm text-muted">
              Sign in to your todosst account once to sync tasks and completions both ways in one click.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-ink text-xl leading-none">
            ×
          </button>
        </div>

        {msg && (
          <p className={`mt-4 rounded-lg border px-3 py-2 text-sm ${msg.ok ? "border-done/50 bg-done/10" : "border-late/50 bg-late/10"}`}>
            {msg.text}
          </p>
        )}

        <section className="mt-5 border-t border-line pt-4">
          {connection === undefined ? (
            <p className="text-sm text-muted">Checking connection…</p>
          ) : connection === null ? (
            <form onSubmit={handleConnect} className="space-y-3">
              <div>
                <h3 className="font-medium">Connect your todosst account</h3>
                <p className="mt-1 text-xs text-muted">
                  Signs in once and keeps a session token — your todosst password is never stored.
                </p>
              </div>
              <div className="space-y-2">
                <input
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="todosst username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={input}
                />
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder="todosst password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={input}
                />
              </div>
              <details className="text-xs text-muted">
                <summary className="cursor-pointer hover:text-ink">Different todosst server?</summary>
                <input
                  type="url"
                  placeholder="https://todosst.vercel.app (default)"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  className={`${input} mt-2`}
                />
              </details>
              <button type="submit" disabled={busy} className={primary}>
                {syncBusy === "connect" ? "Connecting…" : "Connect todosst"}
              </button>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-panel px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="size-2 shrink-0 rounded-full bg-done" aria-hidden />
                    <span className="truncate">Connected as @{connection.username}</span>
                  </div>
                  {connection.lastSyncedAt ? (
                    <p className="mt-0.5 text-xs text-muted">
                      Last synced {formatSyncTime(connection.lastSyncedAt)}
                      {connection.lastSummary ? ` · ${connection.lastSummary}` : ""}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-xs text-muted">Not synced yet.</p>
                  )}
                </div>
                <button
                  onClick={handleDisconnect}
                  disabled={busy}
                  className="shrink-0 text-xs text-muted hover:text-ink disabled:opacity-50"
                >
                  {syncBusy === "disconnect" ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => runSync("both")} disabled={!ready || busy} className={primary}>
                  {syncBusy === "both" ? "Syncing…" : "Sync both ways"}
                </button>
                <button onClick={() => runSync("pull")} disabled={!ready || busy} className={secondary}>
                  {syncBusy === "pull" ? "Pulling…" : "Pull from todosst"}
                </button>
                <button onClick={() => runSync("push")} disabled={!ready || busy} className={secondary}>
                  {syncBusy === "push" ? "Pushing…" : "Push to todosst"}
                </button>
              </div>

              <p className="text-xs text-muted">
                Merges tasks and completions in both directions without deleting anything. Pulled tasks go into{" "}
                <span className="font-mono">todosst/</span> (undoable in the Agent panel); tasks in your other files win and push back to todosst.
              </p>
            </div>
          )}
        </section>

        <details className="mt-5 border-t border-line pt-4">
          <summary className="cursor-pointer text-sm text-muted hover:text-ink">Or transfer with a backup file</summary>
          <div className="mt-4 space-y-5">
            <section>
              <h3 className="text-sm font-medium">Import from todosst backup</h3>
              <div className="mt-2 space-y-2">
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setPlan(null);
                  }}
                  className="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-panel file:px-3 file:py-1.5 file:text-ink"
                />
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="backup passphrase"
                  value={inPass}
                  onChange={(e) => {
                    setInPass(e.target.value);
                    setPlan(null);
                  }}
                  className={input}
                />
                {!plan && (
                  <button onClick={previewFile} disabled={!ready || busy} className={secondary}>
                    {fileBusy === "read" ? "Reading…" : "Preview import"}
                  </button>
                )}
              </div>
              {plan && (
                <div className="mt-3 rounded-lg border border-line bg-panel px-3 py-2.5 text-sm space-y-1.5">
                  <p>Will import {importSummary(plan)}</p>
                  {skippedNote(plan) && <p className="text-muted">{skippedNote(plan)}</p>}
                  {plan.approximate.length > 0 && (
                    <p className="text-muted">Schedules simplified: {plan.approximate.join("; ")}.</p>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button onClick={runFileImport} disabled={busy} className={primary}>
                      {fileBusy === "import" ? "Importing…" : "Import"}
                    </button>
                    <button onClick={() => setPlan(null)} disabled={busy} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="border-t border-line pt-4">
              <h3 className="text-sm font-medium">Download backup for todosst</h3>
              <div className="mt-2 space-y-2">
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="passphrase for the file (8+ characters)"
                  value={outPass}
                  onChange={(e) => setOutPass(e.target.value)}
                  className={input}
                />
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="same passphrase again"
                  value={outPass2}
                  onChange={(e) => setOutPass2(e.target.value)}
                  className={input}
                />
                <button onClick={runFileExport} disabled={!ready || busy} className={secondary}>
                  {fileBusy === "export" ? "Encrypting…" : "Download for todosst"}
                </button>
              </div>
            </section>
          </div>
        </details>
      </div>
    </div>
  );
}

function buildSyncSummary(
  mode: "both" | "pull" | "push",
  counts: {
    pulledFileChanges: number;
    pulledTasks: number;
    pulledLog: number;
    pushedCreated: number;
    pushedUpdated: number;
    pushedHistories: number;
  },
): string {
  const pulledBits: string[] = [];
  if (counts.pulledFileChanges) pulledBits.push(`${plural(counts.pulledTasks, "task")} in ${plural(counts.pulledFileChanges, "file")}`);
  if (counts.pulledLog) pulledBits.push(plural(counts.pulledLog, "completion"));

  const pushedBits: string[] = [];
  if (counts.pushedCreated) pushedBits.push(`${plural(counts.pushedCreated, "new task")}`);
  if (counts.pushedUpdated) pushedBits.push(`${plural(counts.pushedUpdated, "updated task")}`);
  if (counts.pushedHistories) pushedBits.push(`${plural(counts.pushedHistories, "history update")}`);

  const parts: string[] = [];
  if ((mode === "both" || mode === "pull") && pulledBits.length) parts.push(`pulled ${pulledBits.join(" and ")}`);
  if ((mode === "both" || mode === "push") && pushedBits.length) parts.push(`pushed ${pushedBits.join(", ")}`);
  if (!parts.length) return "Already up to date.";
  return `Synced: ${parts.join("; ")}.`;
}
