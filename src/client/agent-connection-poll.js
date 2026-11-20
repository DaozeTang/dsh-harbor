/** Keep agent-requested connections visible even while the SSH pane is closed. */
export function startAgentConnectionPoll(api, announce, timers = globalThis) {
  let stopped = false;
  let polling = false;
  const hidden = () => {
    try {
      return globalThis.document?.visibilityState === "hidden";
    } catch {
      return false;
    }
  };
  const timer = timers.setInterval(async () => {
    // An occluded tab does not need to ask the host for its connection list;
    // the next visible tick catches up before the panel renders.
    if (stopped || polling || hidden()) return;
    polling = true;
    try {
      const listed = await api.list();
      if (!stopped) announce(listed.connections);
    } catch {
      // A temporarily unavailable host must not stop later polls.
    } finally {
      polling = false;
    }
  }, 2500);
  return () => {
    stopped = true;
    timers.clearInterval(timer);
  };
}
