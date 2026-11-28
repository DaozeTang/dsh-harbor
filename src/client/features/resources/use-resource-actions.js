/**
 * Live connection state and the server actions the resource page offers
 * (connect, cancel, disconnect, delete, copy a host fingerprint, delete a
 * shared credential).
 *
 * Kept separate from the page so the render sections stay presentational;
 * inventory, connection status, fingerprint trust and the page error are owned
 * by the page and passed in.
 */
import { useState } from "react";
import { confirmAction } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";
import { harborUiRequestSurface, harborUiSetError, harborUiSetProjectTarget } from "../../state/store.js";
import { requestPaneOpen } from "../../state/pane-selection.js";

export function useResourceActions({ api, refresh, setError, markConnected }) {
  const [connecting, setConnecting] = useState(null);
  const [copiedHostKey, setCopiedHostKey] = useState(null);
  const [hostKeyPopup, setHostKeyPopup] = useState(null);

  const connect = async (profile) => {
    setConnecting(profile.profileId);
    setError(null);
    try {
      // Fast-fail budget: an unreachable host settles in ~15s with a clear
      // error instead of a minute of silent retrying; the user can also
      // cancel the pending handshake explicitly.
      const connection = await api.profileConnect({ profileId: profile.profileId, readyTimeout: 15000, retries: 0 });
      // This page owns no conversation, so the terminal it opens is anonymous;
      // the first pane that claims the reveal adopts it (see requestPaneOpen).
      const session = await api.openSession(connection.connectionId, 100, 30, { openedBy: "panel" });
      if (profile.defaultProjectPath) {
        await api.changeDirectory(session.sessionId, profile.defaultProjectPath);
        harborUiSetProjectTarget(connection.connectionId, profile.defaultProjectPath);
      }
      // This page owns no pane, so queue the connection for one to pick up and
      // ask the host to reveal the terminal. Without both halves a connect here
      // opened nothing and the new server never appeared in the panel.
      requestPaneOpen(connection.connectionId, { adopt: true });
      markConnected(profile);
      // A successful connect must clear any stale panel error (e.g. an earlier
      // host-key mismatch) so the error bar doesn't linger after recovery.
      harborUiSetError(null);
      harborUiRequestSurface();
      await refresh();
    } catch (cause) {
      if (cause?.code === "connect-cancelled") return;
      const message = cause?.message ?? String(cause);
      harborUiSetError(message);
      setError(message);
    } finally {
      setConnecting(null);
    }
  };

  const cancelConnect = async (profile) => {
    try { await api.cancelProfileConnect({ profileId: profile.profileId }); } catch {}
    setConnecting(null);
  };

  const remove = async (profile) => {
    const confirmed = await confirmAction({
      message: t(`删除 SSH 资源“${profile.name}”？这会删除该资源保存的凭据，但不会断开已经建立的连接。`),
      confirmLabel: t("删除"),
      danger: true
    });
    if (!confirmed) return;
    try {
      await api.profileDelete(profile.profileId);
      // Also drop the saved host-key trust record so the deleted server does
      // not linger in the known-hosts list.
      try { await api.forgetHostKey(profile.host, profile.port); } catch {}
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  const disconnectProfile = async (profile) => {
    setError(null);
    try {
      await api.profileDisconnect(profile.profileId);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  const copyHostFingerprint = async (host, port, fingerprint) => {
    const key = host + ":" + port;
    try {
      if (!navigator.clipboard?.writeText) throw new Error(t("当前环境不支持复制到剪贴板"));
      await navigator.clipboard.writeText("SHA256:" + fingerprint);
      setCopiedHostKey(key);
      setTimeout(() => setCopiedHostKey((current) => current === key ? null : current), 1500);
    } catch (cause) {
      setError(cause?.message ?? t("无法复制主机指纹"));
    }
  };

  const removeSharedCredential = async (item) => {
    const confirmed = await confirmAction({
      message: t(`删除共享凭据“${item.name}”？仍被服务器或跳板机引用时不会删除。`),
      confirmLabel: t("删除"),
      danger: true
    });
    if (!confirmed) return;
    try {
      await api.credentialDelete(item.credentialId);
      await refresh({ showLoading: false });
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  return {
    connecting, copiedHostKey, hostKeyPopup, setHostKeyPopup,
    connect, cancelConnect, remove, disconnectProfile,
    copyHostFingerprint, removeSharedCredential
  };
}
