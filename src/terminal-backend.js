/**
 * Companion entry point: the SSH backend of the host's persistent-terminal
 * registry.
 *
 * cordis.patch.yml inserts this row INSIDE the official Persistent terminals
 * group. That group isolates `terminals`, so a sibling profile row cannot see
 * the registry instance the official `terminal_*` tools use; mounting here is
 * what makes `terminal_open({type:'harbor-ssh'})` resolve to Harbor's SSH PTY.
 * The row is skipped when that group is absent (the Persistent terminals
 * plugin is not enabled), and Harbor's own tools keep working without it.
 */
import { harborHub, publishHarborTerminalBackend } from "./shared/service-hub.js";
import { HarborSshBackend } from "./host/terminal-backend.js";

/** Cordis plugin name. */
export const name = "harbor-ssh-terminal";

/** The isolated terminal registry this backend contributes to. */
export const inject = ["terminals"];

/** Register the backend for the lifetime of this row. */
export function apply(ctx) {
  const backend = new HarborSshBackend(harborHub());
  ctx.terminals.registerBackend(backend);
  publishHarborTerminalBackend(backend);
  ctx.effect(() => () => {
    if (harborHub().backend === backend) publishHarborTerminalBackend(null);
  }, "harbor: ssh terminal backend");
}
