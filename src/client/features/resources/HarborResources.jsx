/**
 * Durable SSH resources for the plugin's Settings section.
 *
 * One column, six cards: saved servers, shared credentials, trusted host keys,
 * AI policy, feature switches, then language and update. A settings page is
 * scanned top to bottom, so records are cards instead of tabs, and each card
 * owns exactly one primary action.
 *
 * Server coordinates live in the host storage domain; secrets only cross the
 * web boundary through DSH's credentials.set/unset API and are never put in
 * React state after save.
 */
import * as React from "react";
import { useEffect, useState } from "react";
import { ConfirmHost, ErrorNote, confirmAction } from "../../ui/kit.jsx";
import { installSurfaceStyles } from "../../ui/styles.js";
import SETTINGS_CSS from "./settings.css";
import { t } from "../../../i18n/core.js";
import { useLanguage } from "../../core/locale.js";
import { migrateLegacyProfiles } from "./form.js";
import { inspectInstallation } from "./update-guidance.js";
import { ServerListCard } from "./ServerListCard.jsx";
import { SharedCredentialsCard } from "./SharedCredentialsCard.jsx";
import { KnownHostsCard } from "./KnownHostsCard.jsx";
import { PolicyCard } from "./PolicyCard.jsx";
import { FeatureSwitchesCard } from "./FeatureSwitchesCard.jsx";
import { LanguageUpdateCard } from "./LanguageUpdateCard.jsx";
import { ResourceEditor } from "./ResourceEditor.jsx";
import { SharedCredentialEditor } from "./SharedCredentialEditor.jsx";
import { HostKeyDialog } from "./HostKeyDialog.jsx";
import { ImportSourceDialog } from "./ImportSourceDialog.jsx";
import { OpenSshImportDialog } from "./OpenSshImportDialog.jsx";
import { ResourceBackupDialog } from "./ResourceBackupDialog.jsx";
import { useResourceSettings } from "./use-resource-settings.js";
import { useResourceActions } from "./use-resource-actions.js";

// One sheet for what the kit's shared classes cannot express (group headers,
// grid spans, wrapping rows); installed under its own tag and guarded against
// duplicates by installSurfaceStyles.
installSurfaceStyles("settings", SETTINGS_CSS);

export function HarborResources({ api, credentials, pluginManager, openPluginManager }) {
  // Repaint on language change: every t() call below re-evaluates per render.
  useLanguage();
  const [profiles, setProfiles] = useState([]);
  const [sharedCredentials, setSharedCredentials] = useState([]);
  const [credentialEditor, setCredentialEditor] = useState(null);
  const [backupMode, setBackupMode] = useState(null);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editor, setEditor] = useState(null);
  const [knownHosts, setKnownHosts] = useState([]);
  const [connectedProfiles, setConnectedProfiles] = useState(null);
  const [forgetBusy, setForgetBusy] = useState(null);
  // null = still asking the plugin manager; the card reports what it knows.
  const [installKind, setInstallKind] = useState(null);

  const refresh = async ({ showLoading = true } = {}) => {
    // Poll ticks must not flip the loading flag: the list would unmount and
    // remount every 5 seconds (flicker, scroll and focus loss).
    if (showLoading) setLoading(true);
    try {
      const [profileResult, groupResult, knownResult, credentialResult] = await Promise.all([
        api.profileList(),
        api.groupList(),
        api.listKnownHosts?.().catch(() => ({ hosts: [] })) ?? { hosts: [] },
        api.credentialList()
      ]);
      setProfiles(profileResult.profiles);
      setGroups(groupResult.groups);
      setKnownHosts(knownResult.hosts ?? []);
      setSharedCredentials(credentialResult.credentials ?? []);
      // Deliberately no setError(null) here: this also runs on a 5s poll, and
      // wiping the banner would erase a connect failure before anyone reads it.
      // User actions clear the error when they start.
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  const {
    featureSettings, featureSaving, languageFollow, languageSaving,
    agentAutoConnect, agentSaving, execPolicy, policyLoadFailed,
    execPolicyAllow, exactRules, ruleDraft, setRuleDraft, policyCategories, policySaving,
    defaultUsername, setDefaultUsername,
    applyAgentSettings, reportSettingsLoadFailure,
    toggleAgentAutoConnect, chooseLanguage, toggleLanguageFollow, saveFeature,
    chooseExecPolicy, saveExactRules, togglePolicyCategory
  } = useResourceSettings(api, setError);

  // The connected badge reflects live server-side connections, which also
  // change from outside this page (SSH panel ×, agent, disconnects). Poll
  // so the badge and its 断开 control never go stale.
  useEffect(() => {
    let alive = true;
    let checking = false;
    const refreshStatus = async () => {
      if (checking || document.hidden) return;
      checking = true;
      try {
        const { profileIds } = await api.profileConnectionStatus();
        if (alive) setConnectedProfiles(new Set(profileIds));
      } catch { /* Keep the last known connection status. */ }
      finally { checking = false; }
    };
    void refreshStatus();
    const timer = setInterval(refreshStatus, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [api]);

  // The row's 已连接 badge (and its 断开 control) comes from the 5 s status
  // poll, so right after a successful connect the row still said
  // disconnected and its 连接 button was live — profileConnect does not
  // reuse by default, so a second click opened a second SSH connection.
  const markConnected = (profile) => setConnectedProfiles((current) => {
    const next = new Set(current ?? []);
    next.add(profile.profileId);
    return next;
  });

  const {
    connecting, copiedHostKey, hostKeyPopup,
    setHostKeyPopup, connect, cancelConnect, remove, disconnectProfile,
    copyHostFingerprint, removeSharedCredential
  } = useResourceActions({ api, refresh, setError, markConnected });

  const forgetHost = async (host, port, confirmMessage) => {
    const confirmed = await confirmAction({
      message: confirmMessage ?? t(`忘记 ${host}:${port} 的主机指纹？下次连接将重新信任该服务器当前指纹。仅当服务器被合法重装/更换时才应操作。`),
      confirmLabel: t("忘记"),
      danger: true
    });
    if (!confirmed) return;
    const key = host + ":" + port;
    setForgetBusy(key);
    try {
      await api.forgetHostKey(host, port);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setForgetBusy(null);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try { await migrateLegacyProfiles(api); } catch {}
      // The auto-connect switch is a stored operator setting, not polled live
      // data: load it once and let the toggle own it from there.
      try {
        const settings = await api.agentSettingsGet();
        if (alive) applyAgentSettings(settings);
      } catch {
        if (alive) reportSettingsLoadFailure();
      }
      if (alive) await refresh();
    })();
    return () => { alive = false; };
  }, [api]);

  // The install kind decides which update route the card offers; asking the
  // plugin manager is cheap and the answer never changes during a page life.
  useEffect(() => {
    let alive = true;
    inspectInstallation(pluginManager).then((kind) => { if (alive) setInstallKind(kind); });
    return () => { alive = false; };
  }, [pluginManager]);

  const saveAsResource = (known) => setEditor({
    mode: "new",
    profile: { profileId: undefined, name: known.host, host: known.host, port: known.port, username: "root", authKind: "password", hostKeyMode: "accept-new" }
  });

  return (
    <div className="hb hb-page hb-settings">
      <p className="hb-page__desc">{t("保存的服务器、共享凭据、已知主机与 AI 策略都在这里配置。")}</p>

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <ServerListCard
        api={api}
        profiles={profiles}
        groups={groups}
        knownHosts={knownHosts}
        loading={loading}
        connecting={connecting}
        connectedProfiles={connectedProfiles}
        onReload={refresh}
        onError={setError}
        onConnect={connect}
        onCancelConnect={cancelConnect}
        onDisconnect={disconnectProfile}
        onDelete={remove}
        onEdit={(item) => setEditor({ mode: "edit", profile: item })}
        onShowHostKey={setHostKeyPopup}
        onForgetHostKey={(known) => forgetHost(known.host, known.port)}
        onNewServer={() => setEditor({ mode: "new" })}
        onImport={() => setBackupMode("choose")}
        onExport={() => setBackupMode("export")}
      />

      <SharedCredentialsCard
        sharedCredentials={sharedCredentials}
        loading={loading}
        onAdd={() => setCredentialEditor({})}
        onEdit={(item) => setCredentialEditor(item)}
        onRemove={removeSharedCredential}
      />

      <KnownHostsCard
        knownHosts={knownHosts}
        profiles={profiles}
        forgetBusy={forgetBusy}
        onForget={forgetHost}
        onShowHostKey={setHostKeyPopup}
        onSaveAsResource={saveAsResource}
      />

      <PolicyCard
        agentAutoConnect={agentAutoConnect}
        agentSaving={agentSaving}
        onToggleAgentAutoConnect={toggleAgentAutoConnect}
        policyLoadFailed={policyLoadFailed}
        execPolicy={execPolicy}
        onChooseExecPolicy={chooseExecPolicy}
        execPolicyAllow={execPolicyAllow}
        policyCategories={policyCategories}
        policySaving={policySaving}
        onTogglePolicyCategory={togglePolicyCategory}
        exactRules={exactRules}
        ruleDraft={ruleDraft}
        onRuleDraftChange={setRuleDraft}
        onSaveExactRules={saveExactRules}
      />

      <FeatureSwitchesCard
        featureSettings={featureSettings}
        featureSaving={featureSaving}
        onSaveFeature={saveFeature}
      />

      <LanguageUpdateCard
        languageFollow={languageFollow}
        languageSaving={languageSaving}
        onChooseLanguage={chooseLanguage}
        onToggleLanguageFollow={toggleLanguageFollow}
        installKind={installKind}
        openPluginManager={openPluginManager}
      />

      {hostKeyPopup && (
        <HostKeyDialog
          host={hostKeyPopup.host}
          port={hostKeyPopup.port}
          known={hostKeyPopup}
          copied={copiedHostKey}
          onCopy={copyHostFingerprint}
          onForget={forgetHost}
          forgetBusy={forgetBusy}
          onClose={() => setHostKeyPopup(null)}
        />
      )}
      {editor && (
        <ResourceEditor
          initial={editor.profile}
          groups={groups}
          profiles={profiles}
          sharedCredentials={sharedCredentials}
          api={api}
          credentials={credentials}
          defaultUsername={defaultUsername}
          onClose={() => setEditor(null)}
          onSaved={(saved) => { if (saved?.username) setDefaultUsername(saved.username); return refresh(); }}
        />
      )}
      {credentialEditor && (
        <SharedCredentialEditor
          initial={credentialEditor.credentialId ? credentialEditor : null}
          credentials={credentials}
          api={api}
          onClose={() => setCredentialEditor(null)}
          onSaved={refresh}
        />
      )}
      {backupMode === "choose" && <ImportSourceDialog onSelect={setBackupMode} onClose={() => setBackupMode(null)} />}
      {backupMode === "ssh-config" && (
        <OpenSshImportDialog
          api={api}
          groups={groups}
          profiles={profiles}
          onClose={() => setBackupMode(null)}
          onImported={() => refresh({ showLoading: false })}
        />
      )}
      {(backupMode === "import" || backupMode === "export") && (
        <ResourceBackupDialog
          mode={backupMode}
          api={api}
          onClose={() => setBackupMode(null)}
          onImported={() => refresh({ showLoading: false })}
        />
      )}
      <ConfirmHost />
    </div>
  );
}

