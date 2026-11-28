/**
 * Directory listing and navigation for one connection.
 *
 * Owns the directory being shown, its entries, the selection and the SCP
 * downgrade decision. Two guards stay with the listing because only it can
 * honour them: the monotonic sequence that keeps a slow earlier response from
 * overwriting a newer directory, and the requested-path mirror that lets a
 * failure be retried where it happened.
 *
 * The pane-wide busy/error mirrors are not here: every other group reports into
 * the same banner, so the composition root owns them and passes the setters.
 */
import { useRef, useState } from "react";
import { dirnameOf, joinPath } from "../path-utils.js";
import { t } from "../../../../i18n/core.js";

export function useFileList({ api, connectionId, initialPath, cwdRef, setBusy, setError }) {
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState(null);
  const [listError, setListError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [transferMode, setTransferMode] = useState("sftp");
  const [scpReason, setScpReason] = useState("");
  // Monotonic sequence: only the latest issued directory listing may commit
  // state, so a slow earlier response cannot overwrite a newer directory.
  const loadSeq = useRef(0);
  // The path the newest listing asked for, so a failure can be retried where it
  // happened instead of reloading whichever directory is still current.
  const requestedRef = useRef(initialPath);

  const load = async (path, { preserveError = false } = {}) => {
    const seq = ++loadSeq.current;
    requestedRef.current = path;
    setBusy(true);
    setListError(null);
    if (!preserveError) setError(null);
    setSelected(null);
    try {
      const value = await api.sftpList(connectionId, path);
      if (seq !== loadSeq.current) return;
      setEntries(Array.isArray(value?.entries) ? value.entries : []);
      setCwd(value?.path || path);
      cwdRef.current = value?.path || path;
    } catch (err) {
      if (seq !== loadSeq.current) return;
      // SFTP is the normal file manager. Only failure to OPEN its subsystem
      // merits SCP fallback; permission and path errors stay visible as SFTP
      // errors instead of silently changing transfer semantics.
      if (path === "/" && err?.code === "sftp-failed") {
        setTransferMode("scp");
        setScpReason(err.message ?? t("SFTP 子系统不可用"));
        setEntries(null);
        return;
      }
      setListError(err?.message ?? String(err));
      setEntries([]);
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  };

  const retryList = () => { void load(requestedRef.current); };

  const goUp = () => {
    if (cwd !== "/") load(dirnameOf(cwd));
  };

  const openEntry = (entry) => {
    if (entry.isDirectory) load(joinPath(cwd, entry.name));
  };

  return {
    cwd, entries, selected, setSelected, listError, transferMode, setTransferMode, scpReason, setScpReason,
    load, retryList, goUp, openEntry
  };
}
