/**
 * Remote file browser.
 *
 * One pane for the connected server's filesystem: a path bar (up, breadcrumbs,
 * pin, more), one action row (upload, new folder, refresh, search, filter), the
 * listing under them, and every mutation — upload, download, rename, delete,
 * edit — as an operation with visible progress.
 *
 * Filesystem policy lives in the sibling modules (file-editor.js,
 * sftp-favorites.js, remote-file-search.js, download-checkpoints.js) so the
 * decisions stay testable without a DOM; this file is only the surface.
 * The state groups live in ./hooks (listing, search, editor, transfers,
 * downloads) and the surfaces in the sibling components.
 *
 * Deliberate behaviour that looks surprising:
 * - SFTP is the file manager. Only a failure to OPEN the subsystem falls back
 *   to the SCP pane: a permission or path error must stay visible as an SFTP
 *   error instead of silently changing what the transfer buttons do.
 * - A restartable download is staged in browser-private storage and committed
 *   to the chosen destination only after its checksum matches, so an
 *   interrupted transfer never leaves a half-written file in the user's folder.
 */
import * as React from "react";
import { ErrorNote, IconButton, confirmAction } from "../../ui/kit.jsx";
import { filterEntries } from "./file-editor.js";
import { favoritesKey, readFavorites, toggleFavorite, writeFavorites } from "./sftp-favorites.js";
import { compareEntries } from "./entries.js";
import { joinPath } from "./path-utils.js";
import { useFileList } from "./hooks/useFileList.js";
import { useFileSearch } from "./hooks/useFileSearch.js";
import { useTransfers } from "./hooks/useTransfers.js";
import { useDownloads } from "./hooks/useDownloads.js";
import { useEditor } from "./hooks/useEditor.js";
import { FileToolbar } from "./file-toolbar.jsx";
import { FileList } from "./file-list.jsx";
import { FileSearchPanel } from "./file-search-panel.jsx";
import { FileRowMenu } from "./file-row-menu.jsx";
import { FileEditorPane } from "./file-editor-pane.jsx";
import { ScpPane } from "./scp-pane.jsx";
import { TransferTasks } from "./transfer-tasks.jsx";
import { CreateDirectoryDialog } from "./create-directory-dialog.jsx";
import { RenameDialog } from "./rename-dialog.jsx";
import { UploadConflictDialog } from "./upload-conflict-dialog.jsx";
import { installSurfaceStyles } from "../../ui/styles.js";
import { t } from "../../../i18n/core.js";
import CSS from "./files.css";

const { useEffect, useRef, useState } = React;

installSurfaceStyles("files", CSS);

export function HarborFiles({ api, connection, connectionId, active = true, onCd, initialPath = "/" }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [favorites, setFavorites] = useState([]);
  // The stable per-server key comes from the connection this pane already
  // shows, so it exists on the first render. Asking `api.list()` here left a
  // window where clicking the star updated React state but the write was
  // silently dropped (key === null), then the late lookup overwrote it.
  const favoritesStorageKey = favoritesKey(connection);
  // initialPath is a mount input, not a controlled value: the panel clears
  // the one-shot project target after this mount and must not navigate back.
  const initialPathRef = useRef(initialPath);
  const connectionRef = useRef(connectionId);
  connectionRef.current = connectionId;
  // Mirror of cwd for post-operation refreshes: a mutation that finishes after
  // the user navigated elsewhere must refresh the NEW directory, not snap back.
  const cwdRef = useRef("/");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameTo, setRenameTo] = useState("");
  const [rowMenu, setRowMenu] = useState(null);
  const rowMenuAnchor = useRef(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);
  const dirInputRef = useRef(null);

  const {
    cwd, entries, selected, setSelected, listError, transferMode, setTransferMode, scpReason, setScpReason,
    load, retryList, goUp, openEntry
  } = useFileList({ api, connectionId, initialPath: initialPathRef.current, cwdRef, setBusy, setError });
  const { searchOpen, setSearchOpen, searchQuery, setSearchQuery, searchState, runSearch, cancelSearch } = useFileSearch({ api, connectionId, cwd });
  const {
    tasks, uploading, upload, uploadConflict, conflictApplyAll, setConflictApplyAll, agentTasks,
    scpUploadFile, setScpUploadFile, scpUploadPath, setScpUploadPath, scpDownloadPath, setScpDownloadPath,
    scpUpload, scpDownload, cancelAgentTask, discardAgentTask, cancelTask, clearFinished
  } = useTransfers({ api, connectionId, active, cwd, cwdRef, load, connectionRef, setBusy, setError });
  const {
    persistDownloads, setPersistDownloads, checkpoints, canResumeDownloads, download, resumeCheckpoint, discardCheckpoint
  } = useDownloads({ api, connectionId, cwd, selected, favoritesStorageKey, setBusy, setError });
  const {
    editing, previewChanges, editorBusy, changes, openEditor, saveEditor, closeEditor, setText, togglePreview
  } = useEditor({ api, connectionId, connectionRef, cwd, cwdRef, load, setBusy, setError });

  // Favorites are stored per server under the stable host/port/username key.
  useEffect(() => {
    setFavorites(readFavorites(globalThis.localStorage, favoritesStorageKey));
  }, [favoritesStorageKey]);

  useEffect(() => {
    setTransferMode("sftp");
    setScpReason("");
    setScpUploadFile(null);
    setScpUploadPath("");
    setScpDownloadPath("");
    if (connectionId) load(initialPathRef.current);
  }, [connectionId]);

  const doCreate = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.sftpMkdir(connectionId, joinPath(cwd, newName.trim()));
      setNewName("");
      setCreating(false);
      load(cwdRef.current);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (entry) => {
    const confirmed = await confirmAction({
      message: t(`确定删除远程路径 ${joinPath(cwd, entry.name)} ？此操作不可恢复。`),
      confirmLabel: t("删除"),
      danger: true
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.sftpDelete(connectionId, joinPath(cwd, entry.name));
      setSelected(null);
      load(cwdRef.current);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const doRename = async () => {
    // The dialog pre-fills the current name, so "unchanged" is a no-op the
    // request must not send (the old inline form started empty instead).
    if (!selected || !renameTo.trim() || renameTo.trim() === selected.name) return;
    // A rename onto an existing name replaced that file silently on POSIX
    // servers. The backend refuses it too, but the dialog can say so before the
    // round trip (and before the operator believes the rename succeeded).
    const nextName = renameTo.trim();
    if ((entries ?? []).some((entry) => entry.name === nextName)) {
      setError(t(`目标名称已存在：${nextName}。请换一个名称，或先删除同名项。`));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.sftpRename(connectionId, joinPath(cwd, selected.name), joinPath(cwd, nextName));
      setRenameTo("");
      setRenaming(false);
      setSelected(null);
      load(cwdRef.current);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const persistFavorites = (next) => {
    setFavorites(next);
    writeFavorites(globalThis.localStorage, favoritesStorageKey, next);
  };
  const pinCurrent = () => persistFavorites(toggleFavorite(favorites, cwd).paths);
  const unpin = (path) => persistFavorites(favorites.filter((item) => item !== path));

  /**
   * Leave SCP mode and probe SFTP again.
   *
   * The downgrade is a one-way decision taken by whichever listing failed
   * first, and `sftp-failed` also covers a subsystem that could not open while
   * the transport was reconnecting. Without this, one unlucky first load kept
   * the pane in single-file SCP mode for the whole connection, with delete,
   * rename, mkdir and the editor (all SFTP-only) simply absent.
   */
  const retrySftp = () => {
    if (busy) return;
    setTransferMode("sftp");
    setScpReason("");
    void load("/");
  };

  const visibleEntries = entries === null ? null : filterEntries(entries, filter);
  const sortedEntries = visibleEntries === null ? null : [...visibleEntries].sort(compareEntries);
  const isFavorite = favorites.includes(cwd);

  const chooseFiles = () => fileInputRef.current?.click();
  const chooseFolder = () => dirInputRef.current?.click();
  const closeRowMenu = () => setRowMenu(null);
  const openRowMenu = (event, entry) => {
    rowMenuAnchor.current = event.currentTarget;
    setSelected(entry);
    setRowMenu(entry);
  };
  const startRename = (entry) => {
    setSelected(entry);
    setRenameTo(entry.name);
    setRenaming(true);
  };
  const closeRename = () => setRenaming(false);

  if (transferMode === "scp") {
    return (
      <ScpPane
        busy={busy}
        error={error}
        scpReason={scpReason}
        retrySftp={retrySftp}
        onDismissError={() => setError(null)}
        uploadFile={scpUploadFile}
        uploadPath={scpUploadPath}
        downloadPath={scpDownloadPath}
        onUploadFileChange={setScpUploadFile}
        onUploadPathChange={setScpUploadPath}
        onDownloadPathChange={setScpDownloadPath}
        onUpload={scpUpload}
        onDownload={scpDownload}
      />
    );
  }

  return (
    <div className="hb-files">
      <FileToolbar
        cwd={cwd}
        busy={busy}
        favorites={favorites}
        favoritesStorageKey={favoritesStorageKey}
        isFavorite={isFavorite}
        onGoUp={goUp}
        onNavigate={load}
        onUnpin={unpin}
        onPinCurrent={pinCurrent}
        canResumeDownloads={canResumeDownloads}
        moreOpen={moreOpen}
        onMoreOpenChange={setMoreOpen}
        persistDownloads={persistDownloads}
        onTogglePersistDownloads={() => setPersistDownloads(!persistDownloads)}
        uploading={uploading}
        onChooseFiles={chooseFiles}
        onChooseFolder={chooseFolder}
        onCreateDirectory={() => setCreating(true)}
        onRefresh={() => { void load(cwd); }}
        searchOpen={searchOpen}
        onToggleSearch={() => setSearchOpen(!searchOpen)}
        filter={filter}
        onFilterChange={setFilter}
        fileInputRef={fileInputRef}
        dirInputRef={dirInputRef}
        onUpload={upload}
      />

      {error !== null && (
        <ErrorNote action={<IconButton icon="close-outline" size="sm" label={t("关闭")} onClick={() => setError(null)} />}>
          {error}
        </ErrorNote>
      )}

      {searchOpen && (
        <FileSearchPanel
          searchState={searchState}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onSearch={runSearch}
          onCancel={cancelSearch}
          onClose={() => setSearchOpen(false)}
          onOpenPath={load}
        />
      )}

      <TransferTasks
        agentTasks={agentTasks}
        canDiscardAgentTasks={typeof api.sftpTransferDiscard === "function"}
        onCancelAgentTask={cancelAgentTask}
        onDiscardAgentTask={discardAgentTask}
        tasks={tasks}
        onCancelTask={cancelTask}
        onClearFinished={clearFinished}
        checkpoints={checkpoints}
        onResumeCheckpoint={resumeCheckpoint}
        onDiscardCheckpoint={discardCheckpoint}
      />

      <div
        className="hb-filelist hb-scroll hb-files__list"
        onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          const files = [...(event.dataTransfer?.files ?? [])];
          if (files.length > 0) void upload(files);
        }}
      >
        {dragActive && <div className="hb-files__drop">{t(`松开鼠标：上传到 ${cwd}`)}</div>}
        <FileList
          connectionId={connectionId}
          cwd={cwd}
          entries={entries}
          sortedEntries={sortedEntries}
          listError={listError}
          selected={selected}
          onGoUp={goUp}
          onOpenEntry={openEntry}
          onDownload={download}
          onSelect={setSelected}
          onRowMenu={openRowMenu}
          onRetryList={retryList}
          onChooseFiles={chooseFiles}
          onClearFilter={() => setFilter("")}
        />
      </div>

      <FileRowMenu
        entry={rowMenu}
        anchorRef={rowMenuAnchor}
        cwd={cwd}
        busy={busy}
        onCd={onCd}
        onEnterDirectory={openEntry}
        onDownload={download}
        openEditor={openEditor}
        onRename={startRename}
        onDelete={doDelete}
        onClose={closeRowMenu}
      />

      <CreateDirectoryDialog
        open={creating}
        path={cwd}
        busy={busy}
        name={newName}
        onNameChange={setNewName}
        onClose={() => setCreating(false)}
        onSubmit={doCreate}
      />

      <RenameDialog
        open={renaming && selected !== null}
        cwd={cwd}
        selected={selected}
        busy={busy}
        name={renameTo}
        onNameChange={setRenameTo}
        onClose={closeRename}
        onSubmit={doRename}
      />

      {editing !== null && (
        <FileEditorPane
          editing={editing}
          changes={changes}
          previewChanges={previewChanges}
          editorBusy={editorBusy}
          closeEditor={closeEditor}
          onTogglePreview={togglePreview}
          onSave={saveEditor}
          onChangeText={setText}
        />
      )}

      <UploadConflictDialog
        conflict={uploadConflict}
        applyAll={conflictApplyAll}
        onApplyAllChange={setConflictApplyAll}
      />
    </div>
  );
}
