/**
 * Recursive file search for the current directory.
 *
 * The search belongs to the pane, not to the transfer registry: results are
 * dropped on unmount and on a connection switch, while an upload keeps running.
 * Both aborts live here so the pane cannot leak a search into the next server.
 */
import { useEffect, useRef, useState } from "react";
import { searchRemoteFiles } from "../remote-file-search.js";

export function useFileSearch({ api, connectionId, cwd }) {
  const searchController = useRef(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState(null);

  useEffect(() => () => {
    // Search results belong to this pane; transfers do not. Aborting them here
    // is exactly what used to kill an upload on a server-tab switch.
    searchController.current?.abort();
  }, []);
  useEffect(() => {
    searchController.current?.abort();
    searchController.current = null;
    setSearchState(null);
  }, [connectionId]);

  const runSearch = async () => {
    if (!searchQuery.trim()) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    const root = cwd;
    setSearchState({ running: true, root, visited: 0, results: [], errors: [], reason: null });
    try {
      const result = await searchRemoteFiles((path) => api.sftpList(connectionId, path), root, searchQuery.trim(), { signal: controller.signal });
      if (searchController.current === controller) setSearchState({ ...result, root, running: false });
    } catch (error) {
      // Without this the pane sat on 「搜索中…」 for good: the running flag was
      // only cleared by the success path, and the search button stays disabled
      // while it is true — no way back short of leaving the tab.
      if (searchController.current !== controller) return;
      const cancelled = controller.signal.aborted || error?.name === "AbortError";
      setSearchState({
        root,
        running: false,
        visited: 0,
        results: [],
        errors: [],
        reason: cancelled ? "cancelled" : "failed",
        failure: cancelled ? "" : (error?.message ?? String(error))
      });
    }
  };

  const cancelSearch = () => searchController.current?.abort();

  return { searchOpen, setSearchOpen, searchQuery, setSearchQuery, searchState, runSearch, cancelSearch };
}
