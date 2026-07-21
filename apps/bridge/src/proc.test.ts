// The stop button's contract. Killing only what happens to be running is not enough: a long tool
// runs a SEQUENCE of subprocesses (transcribe = resample -> whisper -> silence detection; auto_clips
// exports one ffmpeg per clip), so without a sticky flag the next step starts right after the kill
// and the work carries on — which is exactly what "stop doesn't stop" looked like in the shipped app.

import { describe, expect, it } from "bun:test";
import { killAgentProcs, resetAgentStop, run, setAgentActive } from "./proc";

// A real executable, NOT `cmd /c ...`: killing a cmd wrapper leaves the grandchild alive holding
// the output pipe, so the read never finishes. ffmpeg and whisper are spawned directly, which is
// why the live kill works — the test has to model that, not a shell.
const SLEEP = ["ping", ["-n", "20", "127.0.0.1"]] as const;

describe("agent stop", () => {
  it("kills a subprocess that is already running", async () => {
    resetAgentStop();
    setAgentActive(true);
    const started = Date.now();
    const p = run(SLEEP[0], [...SLEEP[1]]);
    await Bun.sleep(300); // let it actually start
    const killedCount = killAgentProcs();
    const r = await p;
    setAgentActive(false);
    resetAgentStop();
    expect(killedCount).toBeGreaterThan(0);
    expect(r.code).not.toBe(0); // a killed process never exits cleanly
    expect(Date.now() - started).toBeLessThan(8000); // nowhere near ping's ~19s
  });

  it("also kills a subprocess spawned AFTER the stop — the sequential-tool hole", async () => {
    resetAgentStop();
    setAgentActive(true);
    killAgentProcs(); // stop arrives while the tool is between steps
    const started = Date.now();
    const r = await run(SLEEP[0], [...SLEEP[1]]); // the tool's next step
    setAgentActive(false);
    resetAgentStop();
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("lets the next run proceed once the stop is cleared", async () => {
    resetAgentStop();
    setAgentActive(true);
    killAgentProcs();
    resetAgentStop(); // a new chat run begins
    const r = await run("cmd", ["/c", "echo ok"]);
    setAgentActive(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
  });

  it("leaves non-agent work alone", async () => {
    // An export the user started from the UI must not die because the chat was stopped.
    resetAgentStop();
    setAgentActive(false);
    killAgentProcs();
    const r = await run("cmd", ["/c", "echo untouched"]);
    resetAgentStop();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("untouched");
  });
});
