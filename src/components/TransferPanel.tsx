"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Evaluation, Files, LogEntry } from "@/lib/runtime";
import { backupFilename, buildBackup, buildSnapshot, openBackup, planImport, type ImportPlan } from "@/lib/todosst";

// Moving to and from todosst through its backup file. See src/lib/todosst.ts.

const LOG_BATCH = 400;

const input = "w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-accent";
const primary = "rounded-lg bg-ink text-bg px-3 py-2 text-sm font-medium disabled:opacity-50";

function summary(plan: ImportPlan): string {
  const files = plan.changes.filter((c) => c.source !== null).length;
  const parts = [`${plan.tasks} tasks into ${files} file${files === 1 ? "" : "s"} under todosst/`];
  if (plan.kept) parts.push(`${plan.kept} already defined in your own files (kept as they are)`);
  parts.push(`${plan.log.length} history entries`);
  return parts.join(", ") + ".";
}

function skippedNote(plan: ImportPlan): string | null {
  const s = plan.skipped;
  const bits = [
    s.completed && `${s.completed} completed one-off task${s.completed === 1 ? "" : "s"}`,
    s.avoid && `${s.avoid} avoid (negative) task${s.avoid === 1 ? "" : "s"}`,
    s.habit && `the "open todosst" habit`,
  ].filter(Boolean);
  return bits.length ? `Left in todosst only: ${bits.join(", ")}.` : null;
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
  const post = useMutation(api.program.post);
  const importTotals = useMutation(api.log.importTotals);

  const [file, setFile] = useState<File | null>(null);
  const [inPass, setInPass] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [outPass, setOutPass] = useState("");
  const [outPass2, setOutPass2] = useState("");
  const [busy, setBusy] = useState<"read" | "import" | "export" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const ready = Boolean(files && evaluation);

  async function preview() {
    setMsg(null);
    setPlan(null);
    if (!file) return setMsg({ ok: false, text: "Choose the backup file you exported from todosst." });
    if (!files || !evaluation) return;
    setBusy("read");
    try {
      const snap = await openBackup(await file.text(), inPass);
      setPlan(planImport(snap, { files, existing: evaluation.tasks, now: Date.now() }));
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    if (!plan) return;
    setBusy("import");
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
      setBusy(null);
    }
  }

  async function runExport() {
    setMsg(null);
    if (!evaluation) return;
    if (outPass.length < 8) return setMsg({ ok: false, text: "Pick a passphrase of at least 8 characters (todosst asks for it on import)." });
    if (outPass !== outPass2) return setMsg({ ok: false, text: "The passphrases do not match." });
    setBusy("export");
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
        text: `Downloaded ${evaluation.tasks.length} tasks and ${snap.history.length} histories.${errs ? ` ${errs} file error${errs === 1 ? "" : "s"} in your program: tasks in a broken file are not included.` : ""}`,
      });
      setOutPass("");
      setOutPass2("");
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-bg/90 px-4 py-10" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Move between todosst and the agent"
        className="w-full max-w-lg rounded-xl border border-line bg-bg p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Move between apps</h2>
            <p className="mt-1 text-sm text-muted">
              Copies your tasks and history between todosst and here, through todosst&apos;s backup file. Both directions are safe to repeat: nothing is duplicated or counted twice.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-ink text-xl leading-none">
            ×
          </button>
        </div>

        {msg && (
          <p className={`mt-4 rounded-lg border px-3 py-2 text-sm ${msg.ok ? "border-done/50 bg-done/10" : "border-late/50 bg-late/10"}`}>{msg.text}</p>
        )}

        <section className="mt-5 border-t border-line pt-4">
          <h3 className="font-medium">From todosst to here</h3>
          <ol className="mt-1 list-decimal pl-5 text-sm text-muted space-y-0.5">
            <li>In todosst, open settings, export, and download the file.</li>
            <li>Choose it below with the same passphrase.</li>
          </ol>
          <div className="mt-3 space-y-2">
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
              <button onClick={preview} disabled={!ready || busy !== null} className={primary}>
                {busy === "read" ? "Reading…" : "Preview import"}
              </button>
            )}
          </div>
          {plan && (
            <div className="mt-3 rounded-lg border border-line bg-panel px-3 py-2.5 text-sm space-y-1.5">
              <p>Will import {summary(plan)}</p>
              {skippedNote(plan) && <p className="text-muted">{skippedNote(plan)}</p>}
              {plan.approximate.length > 0 && (
                <p className="text-muted">Schedules simplified: {plan.approximate.join("; ")}.</p>
              )}
              <p className="text-muted">Files already in todosst/ are replaced; your other files are untouched.</p>
              <div className="flex gap-2 pt-1">
                <button onClick={runImport} disabled={busy !== null} className={primary}>
                  {busy === "import" ? "Importing…" : "Import"}
                </button>
                <button onClick={() => setPlan(null)} disabled={busy !== null} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="mt-5 border-t border-line pt-4">
          <h3 className="font-medium">From here to todosst</h3>
          <p className="mt-1 text-sm text-muted">
            Downloads a todosst backup of your program and history. In todosst, open settings, import, and keep
            &ldquo;merge by path&rdquo; on: tasks you already have there are updated, new ones are added.
          </p>
          <div className="mt-3 space-y-2">
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
            <button onClick={runExport} disabled={!ready || busy !== null} className={primary}>
              {busy === "export" ? "Encrypting…" : "Download for todosst"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
