/**
 * Operator settings loaded once by the resource page: the agent auto-connect
 * switch, the execution-policy card's state, feature switches, the interface
 * language, and the username the new-server form prefills.
 *
 * The page owns one agentSettingsGet call (settings pages are loaded once),
 * so the loader lives here and the page hands the answer to
 * applyAgentSettings.
 */
import { useEffect, useState } from "react";
import { confirmAction } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";
import { getLanguage, setLanguage } from "../../core/locale.js";
import { harborUiSetFeatures } from "../../state/store.js";
import { TIER_ORDER, execPolicyLabel, execPolicyLooseningDetail } from "../policy/exec-policy-ui.js";

export function useResourceSettings(api, setError) {
  const [featureSettings, setFeatureSettings] = useState(null);
  const [featureSaving, setFeatureSaving] = useState(false);
  // Whether the interface language follows DSH's own setting. Loaded from the
  // host so the switch reports what the next boot will actually do.
  const [languageFollow, setLanguageFollow] = useState(true);
  const [languageSaving, setLanguageSaving] = useState(false);
  // null = not loaded yet; the switch stays disabled until the host answers.
  const [agentAutoConnect, setAgentAutoConnect] = useState(null);
  const [agentSaving, setAgentSaving] = useState(false);
  // Execution policy (AI high-risk command gate): null = loading; the segment
  // and checklist stay disabled until the host answers.
  const [execPolicy, setExecPolicy] = useState(null);
  const [policyLoadFailed, setPolicyLoadFailed] = useState(false);
  const [execPolicyAllow, setExecPolicyAllow] = useState([]);
  const [exactRules, setExactRules] = useState([]);
  const [ruleDraft, setRuleDraft] = useState("");
  const [policyCategories, setPolicyCategories] = useState([]);
  const [policySaving, setPolicySaving] = useState(false);
  // Username the new-server form prefills: auto-remembered host-side from the
  // last profileSave (issue #36 feedback) — no manual knob, null falls back
  // to "root". Loaded once with the rest of the settings; updated locally
  // again whenever an editor saves.
  const [defaultUsername, setDefaultUsername] = useState(null);

  const applyAgentSettings = (settings) => {
    if (settings.features) {
      setFeatureSettings(settings);
      harborUiSetFeatures(settings.features);
    }
    setAgentAutoConnect(settings.agentAutoConnect === true);
    setPolicyLoadFailed(false);
    setExecPolicy(settings.execPolicy ?? "standard");
    setExecPolicyAllow(settings.execPolicyAllow ?? []);
    setExactRules(settings.execPolicyExact ?? []);
    setRuleDraft((settings.execPolicyExact ?? []).join("\n"));
    setPolicyCategories(settings.categories ?? []);
    setDefaultUsername(settings.defaultUsername ?? null);
  };

  const reportSettingsLoadFailure = () => {
    setAgentAutoConnect(false);
    // Do not invent "standard": a failed read is not the same as a host
    // that really runs the standard gate, and choosing a tier from a
    // fake baseline could loosen or tighten the wrong thing.
    setPolicyLoadFailed(true);
  };

  // The follow switch reports what the host stored; reading it here keeps the
  // page honest after a reload instead of assuming the default.
  useEffect(() => {
    let alive = true;
    api.languageGet()
      .then((value) => { if (alive) setLanguageFollow(value?.autoApplySystemLanguage !== false); })
      .catch(() => {});
    return () => { alive = false; };
  }, [api]);

  const toggleAgentAutoConnect = async (next) => {
    setAgentSaving(true);
    try {
      const saved = await api.agentSettingsSave(next);
      setAgentAutoConnect(saved.agentAutoConnect === true);
      setError(null);
    } catch (cause) {
      // A failed save must not look applied: put the switch back on the value
      // the host still enforces.
      setError(cause?.message ?? String(cause));
      setAgentAutoConnect(!next);
    } finally {
      setAgentSaving(false);
    }
  };

  /**
   * An explicit language choice pins the plugin to it: the same call stores the
   * language and stops the next load from re-adopting DSH's own language.
   */
  const chooseLanguage = async (next) => {
    if (languageSaving) return;
    const previous = getLanguage();
    setLanguage(next);
    setLanguageSaving(true);
    try {
      const saved = await api.languageSave(next, false);
      setLanguageFollow(saved?.autoApplySystemLanguage !== false);
      setError(null);
    } catch (cause) {
      // A rejected save must not leave the page speaking a language the host
      // did not record.
      setLanguage(previous);
      setError(cause?.message ?? String(cause));
    } finally {
      setLanguageSaving(false);
    }
  };

  /**
   * Following DSH re-adopts its language on the next load; turning the switch
   * off pins whatever language the page is showing now.
   */
  const toggleLanguageFollow = async (next) => {
    if (languageSaving) return;
    setLanguageSaving(true);
    try {
      const saved = await api.languageSave(next ? undefined : getLanguage(), next);
      setLanguageFollow(saved?.autoApplySystemLanguage !== false);
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setLanguageSaving(false);
    }
  };

  const saveFeature = async (key, value) => {
    setFeatureSaving(true);
    try {
      const saved = await api.saveFeatureSettings({ [key]: value });
      setFeatureSettings(saved);
      harborUiSetFeatures(saved.features);
      setError(null);
    } catch (error) {
      setError(error?.message ?? String(error));
    } finally {
      setFeatureSaving(false);
    }
  };

  /**
   * Persist the global execution policy and (for the custom tier) the released
   * categories. Saves carry the auto-connect switch too, since the settings
   * row is one record — the current state travels with the policy.
   */
  const saveExecPolicy = async (policy, allow, exact) => {
    setPolicySaving(true);
    try {
      const saved = await api.agentSettingsSave(agentAutoConnect === true, policy, allow, undefined, exact);
      setExecPolicy(saved.execPolicy ?? "standard");
      setExecPolicyAllow(saved.execPolicyAllow ?? []);
      setExactRules(saved.execPolicyExact ?? []);
      if (exact !== undefined) setRuleDraft((saved.execPolicyExact ?? []).join("\n"));
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setPolicySaving(false);
    }
  };

  const chooseExecPolicy = async (policy) => {
    if (policySaving || execPolicy === null || policy === execPolicy) return;
    // Loosening is the direction that can destroy data, so it asks first —
    // the same rule (and the same wording) the terminal panel's policy pill
    // follows. Tightening applies at once, because nobody needs to confirm
    // making the gate stricter.
    if (TIER_ORDER[policy] > TIER_ORDER[execPolicy]) {
      const detail = execPolicyLooseningDetail(policy, execPolicyAllow.length);
      const confirmed = await confirmAction({
        message: t(`确认放宽为「${execPolicyLabel(policy)}」？`) + "\n\n" + detail,
        confirmLabel: t("继续"),
        danger: true
      });
      if (!confirmed) return;
    }
    await saveExecPolicy(policy, execPolicyAllow);
  };

  const saveExactRules = async () => {
    const rules = [...new Set(ruleDraft.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    if (rules.some((rule) => !exactRules.includes(rule))) {
      const confirmed = await confirmAction({
        message: t("保存后，AI 可在使用自定义放行策略的连接上直接执行新增的精确命令。继续吗？"),
        confirmLabel: t("继续"),
        danger: true
      });
      if (!confirmed) return;
    }
    await saveExecPolicy("custom", execPolicyAllow, rules);
  };

  const togglePolicyCategory = (key) => {
    if (policySaving) return;
    const next = execPolicyAllow.includes(key)
      ? execPolicyAllow.filter((item) => item !== key)
      : [...execPolicyAllow, key];
    void saveExecPolicy("custom", next);
  };

  return {
    featureSettings, featureSaving, languageFollow, languageSaving,
    agentAutoConnect, agentSaving, execPolicy, policyLoadFailed,
    execPolicyAllow, exactRules, ruleDraft, setRuleDraft, policyCategories, policySaving,
    defaultUsername, setDefaultUsername,
    applyAgentSettings, reportSettingsLoadFailure,
    toggleAgentAutoConnect, chooseLanguage, toggleLanguageFollow, saveFeature,
    chooseExecPolicy, saveExactRules, togglePolicyCategory
  };
}

