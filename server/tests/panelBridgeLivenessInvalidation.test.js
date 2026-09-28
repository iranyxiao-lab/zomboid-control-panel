import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { readFile } from "fs/promises";

// 2026-09-29, operator report: "after clicking Stop the dashboard still offers
// no Restart/Start button".
//
// PanelBridge's status-file staleness grace exists for a LIVE but EMPTY
// server -- PZ stops ticking Lua with 0 players -- so an empty server is
// judged by statusStaleIdleMs (5 min) rather than statusStaleMs (45 s).
// Nothing in that grace knows the panel has SINCE confirmed the process died,
// so a >45s-but-<5min old heartbeat kept isModConnected() true for the whole
// grace period. The dashboard picks its Start/Stop branch from
// `hostRunning || rconConnected || bridgeActive`, so the UI stayed on the Stop
// branch -- no Start button -- even though the process was gone and RCON was
// down. Fix under test: invalidateModLiveness(), which the status watchdog
// calls the moment it observes running -> stopped, retires every heartbeat
// written BEFORE that moment. See panelBridge.js's own comment for why this
// can't hide a process-scan false negative.
vi.mock("../database/init.js", () => ({
  logPlayerAction: vi.fn(async () => {}),
  recordPlayerSession: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  applySuspendGapToInFlightSessions: vi.fn(async () => ({ adjustedPlayers: [] })),
}));

const { PanelBridge } = await import("../services/panelBridge.js");

const STATUS_BODY = JSON.stringify({
  alive: true,
  version: "1.7.70",
  protocolVersion: "queue-v1",
  serverName: "servertest123",
  playerCount: 0,
  players: [],
});

/** Write the mod's heartbeat and back-date it, the way an idle server looks. */
function writeStatus(directory, ageMs) {
  const statusFile = path.join(directory, "status.json.txt");
  fs.writeFileSync(statusFile, STATUS_BODY);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(statusFile, when, when);
  return statusFile;
}

/** A bridge on a temp dir with one heartbeat written `ageMs` ago, already read once. */
function makeBridge(ageMs = 60_000) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pz-bridge-liveness-"));
  writeStatus(directory, ageMs);
  const bridge = new PanelBridge();
  bridge.configure(directory, true);
  bridge.checkModStatus();
  return { bridge, directory };
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

describe("PanelBridge liveness invalidation after a confirmed stop", () => {
  it("baseline: a quiet 60s-old heartbeat on an EMPTY server still counts as connected (the idle grace this fix must not break)", () => {
    const { bridge, directory } = makeBridge(60_000);
    try {
      expect(bridge.modStatus.playerCount).toBe(0);
      expect(bridge.modStatus.age).toBeGreaterThan(bridge.config.statusStaleMs);
      expect(bridge.isModConnected()).toBe(true);
    } finally {
      cleanup(directory);
    }
  });

  it("THE REPORTED BUG: once invalidated, that same pre-stop heartbeat can no longer report the mod as connected", () => {
    const { bridge, directory } = makeBridge(60_000);
    try {
      expect(bridge.isModConnected()).toBe(true);

      bridge.invalidateModLiveness("server stopped (reason: stop)");
      expect(bridge.isModConnected()).toBe(false);

      // It must STAY false: the file is still on disk and still younger than
      // the 5-minute idle grace, which is exactly the window the panel used
      // to spend on the Stop branch with no Start button.
      bridge.checkModStatus();
      bridge.checkModStatus();
      expect(bridge.isModConnected()).toBe(false);
    } finally {
      cleanup(directory);
    }
  });

  it("self-correcting: a heartbeat written AFTER the invalidation counts again, so a process-scan false negative is not hidden", () => {
    const { bridge, directory } = makeBridge(60_000);
    try {
      bridge.invalidateModLiveness("server stopped");
      expect(bridge.isModConnected()).toBe(false);

      // The mod is clearly still alive and writing -- the panel just could not
      // see its process this once.
      writeStatus(directory, 0);
      bridge.checkModStatus();
      expect(bridge.isModConnected()).toBe(true);
    } finally {
      cleanup(directory);
    }
  });

  it("emits modStatus exactly once when it demotes a live status, so connected clients flip without waiting for a poll", () => {
    const { bridge, directory } = makeBridge(60_000);
    try {
      const seen = [];
      bridge.on("modStatus", (status) => seen.push(status.alive));

      bridge.invalidateModLiveness("server stopped");
      expect(seen).toEqual([false]);

      // Nothing alive left to demote: no duplicate event, no repeated log line.
      bridge.invalidateModLiveness("server stopped");
      bridge.checkModStatus();
      expect(seen).toEqual([false]);
    } finally {
      cleanup(directory);
    }
  });

  it("start() clears the invalidation, so a restarted server's fresh heartbeats count normally", () => {
    const { bridge, directory } = makeBridge(60_000);
    try {
      bridge.invalidateModLiveness("server stopped");
      expect(bridge.heartbeatInvalidBefore).not.toBeNull();

      // start() would otherwise spin up real intervals/watchers in a unit test.
      bridge.ensureQueueProtocol = vi.fn();
      bridge.setupFileWatcher = vi.fn();
      bridge.checkModStatus = vi.fn();
      bridge.start();

      expect(bridge.heartbeatInvalidBefore).toBeNull();
      bridge.stop();
    } finally {
      cleanup(directory);
    }
  });

  it("the status watchdog wires the invalidation into its running -> stopped transition", async () => {
    // Source-level check (this codebase's pattern for wiring that only exists
    // inside the index.js monolith): the call has to sit in the same branch
    // that records lastStopReason, or the fix silently stops reaching the UI.
    const source = await readFile(path.resolve(process.cwd(), "server/index.js"), "utf8");
    const stopBranch = source.match(
      /if \(runningChanged && !running\) \{([\s\S]*?)\n {6}\}/,
    );

    expect(stopBranch?.[1]).toMatch(/serverManager\.lastStopReason = stopReason;/);
    expect(stopBranch?.[1]).toMatch(/panelBridge\?\.invalidateModLiveness\?\.\(/);
  });

  it("the status watchdog ALSO invalidates on the first stopped observation after a panel start", async () => {
    // A cold start is not a transition -- lastKnownRunning is still null when
    // the first scan comes back "stopped" -- so this case needs its own guard,
    // placed immediately before the observed state is stored. Without it, a
    // panel restarted while the server was already down kept showing no Start
    // button for the rest of the idle grace (2026-09-29, found while deploying
    // the transition fix itself).
    const source = await readFile(path.resolve(process.cwd(), "server/index.js"), "utf8");

    expect(source).toMatch(
      /if \(lastKnownRunning === null && !running\) \{\s*panelBridge\?\.invalidateModLiveness\?\.\(/,
    );
  });
});
