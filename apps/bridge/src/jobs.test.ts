// Long operations and the ability to stop them. What is being pinned here is the behaviour that was
// missing when a sync on two half-hour cameras made a machine unusable: nothing said what was
// running, nothing could stop it, and killing only the step in flight let the next one start anyway.

import { describe, expect, it } from "bun:test";
import { beginJob, cancelJob, currentJob_, endJob, jobCancelled, run } from "./proc";

describe("jobs", () => {
  it("reports nothing running when nothing is", () => {
    expect(currentJob_()).toBeNull();
    expect(jobCancelled()).toBe(false);
  });

  it("names the running operation, so the UI can say what it is waiting for", () => {
    beginJob("j1", "tool", "Syncing cameras");
    expect(currentJob_()?.label).toBe("Syncing cameras");
    endJob("j1");
    expect(currentJob_()).toBeNull();
  });

  it("has nothing to cancel when idle", () => {
    expect(cancelJob()).toBe(false);
  });

  it("kills the subprocess it is running", async () => {
    beginJob("j2", "tool", "Waiting");
    // A direct executable, not a shell wrapper: killing a `cmd /c` leaves the grandchild holding
    // the pipe open and the read never finishes.
    const p = run("ping", ["-n", "30", "127.0.0.1"]);
    await new Promise((r) => setTimeout(r, 200));
    expect(cancelJob()).toBe(true);
    const started = Date.now();
    await p;
    expect(Date.now() - started).toBeLessThan(3000); // died, rather than running its 30 pings
    endJob("j2");
  });

  it("kills what starts AFTER the stop, not just what was already running", async () => {
    // The trap that made an earlier stop button useless: these operations run a SEQUENCE of
    // subprocesses, so killing the current one lets the next start immediately and the work carries
    // on as if nothing happened.
    beginJob("j3", "tool", "Sequence");
    cancelJob();
    const started = Date.now();
    await run("ping", ["-n", "30", "127.0.0.1"]);
    expect(Date.now() - started).toBeLessThan(3000);
    endJob("j3");
  });

  it("tells the operation it was asked to stop, so it can bail out between steps", () => {
    beginJob("j4", "tool", "Stoppable");
    expect(jobCancelled()).toBe(false);
    cancelJob();
    expect(jobCancelled()).toBe(true);
    endJob("j4");
  });

  it("only cancels the job it was asked to cancel", () => {
    beginJob("j5", "tool", "Mine");
    expect(cancelJob("somebody-else")).toBe(false);
    expect(jobCancelled()).toBe(false);
    endJob("j5");
  });

  it("a stale end() does not clear the job that replaced it", () => {
    beginJob("old", "tool", "Old");
    beginJob("new", "tool", "New");
    endJob("old");
    expect(currentJob_()?.id).toBe("new");
    endJob("new");
  });

  it("starts clean: a new job is not born cancelled by the previous one's stop", () => {
    beginJob("j6", "tool", "First");
    cancelJob();
    endJob("j6");
    beginJob("j7", "tool", "Second");
    expect(jobCancelled()).toBe(false);
    endJob("j7");
  });
});
