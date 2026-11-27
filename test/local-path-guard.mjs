import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLocalAgentPath, isLocalPathInside, resolveLocalAgentPath } from "../src/host/local-path-guard.js";
import { registerSftpTools } from "../src/host/tools/sftp.js";

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "dsh-local-path-"));
  const workspace = join(base, "workspace");
  const outside = join(base, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(workspace, "inside.txt"), "inside");
  writeFileSync(join(outside, "secret.txt"), "outside");
  return { base, workspace, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// ── pure path decisions ─────────────────────────────────────────────────────
{
  const box = sandbox();
  try {
    assert.equal(resolveLocalAgentPath("sub/file.txt", box.workspace), join(box.workspace, "sub/file.txt"),
      "a relative path is anchored at the session workspace");
    assert.equal(resolveLocalAgentPath(join(box.outside, "x"), box.workspace), join(box.outside, "x"),
      "an absolute path is taken as-is");
    assert.throws(() => resolveLocalAgentPath("", box.workspace), /non-empty/);
    assert.throws(() => resolveLocalAgentPath("a\0b", box.workspace), /NUL/);

    assert.equal(isLocalPathInside(box.workspace, join(box.workspace, "a", "b")), true);
    assert.equal(isLocalPathInside(box.workspace, box.workspace), true);
    assert.equal(isLocalPathInside(box.workspace, join(box.workspace, "..", "outside")), false);

    const inside = await inspectLocalAgentPath(join(box.workspace, "inside.txt"), box.workspace);
    assert.equal(inside.inside, true, "an ordinary workspace file is inside");
    assert.equal(inside.canonical, join(inside.workspaceCanonical, "inside.txt"));

    const outside = await inspectLocalAgentPath(join(box.outside, "secret.txt"), box.workspace);
    assert.equal(outside.inside, false, "a sibling directory is outside");

    // Only a leading ".." SEGMENT leaves the tree: a file literally named
    // "..env" is ordinary workspace content, not a traversal.
    writeFileSync(join(box.workspace, "..env"), "dotted");
    const dotted = await inspectLocalAgentPath(join(box.workspace, "..env"), box.workspace);
    assert.equal(dotted.inside, true, "a name that merely starts with '..' is still inside");
    assert.equal(isLocalPathInside(box.workspace, join(box.workspace, "..env")), true);

    const missing = await inspectLocalAgentPath(join(box.workspace, "new", "tree"), box.workspace);
    assert.equal(missing.inside, true, "a not-yet-created destination under the workspace is allowed");

    if (process.platform !== "win32") {
      symlinkSync(box.outside, join(box.workspace, "link"));
      const viaLink = await inspectLocalAgentPath(join(box.workspace, "link", "secret.txt"), box.workspace);
      assert.equal(viaLink.inside, false, "a symlink inside the workspace that points outside is not inside");
    }
  } finally { box.cleanup(); }
}

// ── tool-level approval contract ────────────────────────────────────────────
function harness({ workspace, outcome, withApproval = true }) {
  const tools = [];
  const asked = [];
  const calls = [];
  const service = {
    sessionDirectoryOf: () => workspace,
    config: {},
    resolveRemoteToolPath: async ({ path }) => ({ connectionId: "c1", path, bound: false }),
    touchAgentTarget: async () => ({ ok: true, value: { connectionId: "c1" } }),
    sftpUploadLocalFile: async (request) => {
      calls.push({ tool: "upload", request });
      return { ok: true, value: { taskId: "t", source: request.localPath, target: request.remotePath, bytes: 1, resumed: false, startOffset: 0 } };
    },
    sftpUploadDir: async (request) => {
      calls.push({ tool: "upload-dir", request });
      return { ok: true, value: { source: request.localPath, target: request.remotePath, directories: 1, files: 0, bytes: 0, failed: [] } };
    },
    sftpDownloadDir: async (request) => {
      calls.push({ tool: "download-dir", request });
      return { ok: true, value: { source: request.remotePath, target: request.localPath, directories: 1, files: 0, bytes: 0, failed: [] } };
    }
  };
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    on: () => {},
    get: (name) => (name === "approval" && withApproval
      ? { request: async (request) => { asked.push(request); return outcome; } }
      : undefined)
  };
  registerSftpTools(ctx, service);
  const tool = (name) => tools.find((item) => item.name === name);
  const exec = { agent: { id: "agent-1" }, callId: "call-1" };
  return { tool, asked, calls, exec };
}

{
  const box = sandbox();
  try {
    // Inside the workspace: no prompt, the absolute source reaches the service.
    {
      const h = harness({ workspace: box.workspace, outcome: "rejected" });
      const value = await h.tool("sftp_upload_file").execute({ local_path: "inside.txt", remote_path: "/r/inside.txt" }, h.exec);
      assert.equal(value.taskId, "t");
      assert.equal(h.asked.length, 0, "workspace-local work never prompts");
      assert.equal(h.calls[0].request.localPath, join(box.workspace, "inside.txt"), "relative sources are handed over as absolute paths");
    }

    // Outside + rejected: nothing is read.
    {
      const h = harness({ workspace: box.workspace, outcome: "rejected" });
      await assert.rejects(
        () => h.tool("sftp_upload_file").execute({ local_path: join(box.outside, "secret.txt"), remote_path: "/r/secret.txt" }, h.exec),
        /sftp_upload_file failed: 操作者拒绝/
      );
      assert.equal(h.asked.length, 1);
      assert.match(h.asked[0].reason, /工作区之外的本地路径/);
      assert.match(h.asked[0].reason, /secret\.txt/);
      assert.equal(h.calls.length, 0, "a rejected path is never read");
    }

    // Outside + allowed-once: exactly this call proceeds.
    {
      const h = harness({ workspace: box.workspace, outcome: "allowed-once" });
      const value = await h.tool("sftp_upload_file").execute({ local_path: join(box.outside, "secret.txt"), remote_path: "/r/secret.txt" }, h.exec);
      assert.equal(value.taskId, "t");
      assert.equal(h.asked.length, 1);
      assert.equal(h.calls[0].request.localPath, join(box.outside, "secret.txt"));
    }

    // No approval channel: fail closed, never read outside the workspace.
    {
      const h = harness({ workspace: box.workspace, outcome: "unavailable", withApproval: false });
      await assert.rejects(
        () => h.tool("sftp_upload_dir").execute({ local_path: box.outside, remote_path: "/r" }, h.exec),
        /没有可用的审批通道/
      );
      assert.equal(h.calls.length, 0);
    }

    // A download destination outside the workspace uses the write wording.
    {
      const h = harness({ workspace: box.workspace, outcome: "allowed-once" });
      const value = await h.tool("sftp_download_dir").execute({ remote_path: "/remote", local_path: box.outside }, h.exec);
      assert.equal(value.target, box.outside);
      assert.equal(h.asked.length, 1);
      assert.match(h.asked[0].reason, /写入/);
      assert.equal(h.calls[0].tool, "download-dir");
    }

    // An inside download destination never prompts.
    {
      const h = harness({ workspace: box.workspace, outcome: "rejected" });
      await h.tool("sftp_download_dir").execute({ remote_path: "/remote", local_path: "downloads" }, h.exec);
      assert.equal(h.asked.length, 0);
      assert.equal(h.calls[0].request.localPath, join(box.workspace, "downloads"));
    }
  } finally { box.cleanup(); }
}

console.log("local path guard: workspace boundary and one-call operator approval verified");
