/**
 * Command snippets: a searchable palette that TYPES into the terminal.
 *
 * It never runs anything — filling the input line is the whole action, so the
 * operator can edit or abandon a command before Enter. Snippets with
 * {{parameters}} open a small form first; the preview shows the exact line that
 * will be typed, which is also where a malformed placeholder becomes visible.
 */
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, EmptyState, Field, Icon, IconButton, Row, Select, TextInput, confirmAction, toast } from "../../ui/kit.jsx";
import {
  availableCommandSnippets, expandSnippet, loadCommandSnippets, matchingCommandSnippets,
  saveCommandSnippets, searchCommandSnippets, snippetParameters
} from "../../command-snippets.js";
import { harborUiSetError } from "../../store.js";
import { resolvePaneTerminal } from "../../session-terminals.js";
import { t } from "../../../i18n/core.js";

export function SnippetsView({ api, active, sessionId, profiles, groups, onFilled, shown = false }) {
  const [items, setItems] = useState(loadCommandSnippets);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState({ name: "", command: "", scope: "global", scopeId: "" });
  const searchRef = useRef(null);

  useEffect(() => {
    const sync = () => setItems(loadCommandSnippets());
    window.addEventListener("dsh-harbor-command-snippets", sync);
    return () => window.removeEventListener("dsh-harbor-command-snippets", sync);
  }, []);

  // Every tab stays mounted and inactive ones are hidden with CSS, so the
  // mount-time autofocus ran against a `display:none` element and, having no
  // effect, never ran again: arriving at the tab left the search box unfocused.
  useEffect(() => {
    if (!shown) return undefined;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [shown]);

  // Type into THIS conversation's terminal. `sessionId` is the DSH conversation
  // id — a PTY id only looks similar. Passing it straight to api.write meant
  // every snippet failed with no-session, because the host looks the id up in
  // its terminal table. resolvePaneTerminal owns that translation (and keeps the
  // older-host fallback of "the connection's only shell").
  const targetSessionId = resolvePaneTerminal(active, sessionId).sessionId;
  const visible = useMemo(
    () => searchCommandSnippets(matchingCommandSnippets(availableCommandSnippets(items), active, profiles), query),
    [items, active, profiles, query]
 );

  useEffect(() => {
    if (draft !== null && draft.sessionId !== targetSessionId) setDraft(null);
  }, [draft, targetSessionId]);

  const fill = async (command, expectedSessionId) => {
    if (targetSessionId === null) return harborUiSetError(t("请先打开当前服务器的终端，再填入快捷命令"));
    if (expectedSessionId !== undefined && targetSessionId !== expectedSessionId) return;
    try {
      await api.write(targetSessionId, command);
      setDraft(null);
      setQuery("");
      onFilled?.();
    } catch (error) {
      harborUiSetError(t(`填入快捷命令失败：${error?.message ?? String(error)}`));
    }
  };

  const choose = (item) => {
    if (targetSessionId === null) return harborUiSetError(t("请先打开当前服务器的终端，再填入快捷命令"));
    const parameters = snippetParameters(item.command);
    if (parameters.length > 0) setDraft({ item, parameters, sessionId: targetSessionId });
    else void fill(item.command);
  };

  const save = () => {
    const name = form.name.trim();
    const command = form.command.trim();
    if (name === "" || command === "") return harborUiSetError(t("请填写快捷命令的名称和命令内容"));
    if (form.scope !== "global" && form.scopeId === "") return harborUiSetError(t("请选择命令适用的分组或服务器"));
    const next = [...items, {
      id: crypto.randomUUID(), name, command, scope: form.scope,
      scopeId: form.scope === "global" ? null : form.scopeId
    }];
    saveCommandSnippets(next);
    setItems(next);
    setForm({ name: "", command: "", scope: "global", scopeId: "" });
    setEditorOpen(false);
    toast(t("已保存快捷命令"));
  };

  const remove = async (item) => {
    const confirmed = await confirmAction({
      message: t(`删除自定义快捷命令“${item.name}”？`),
      confirmLabel: t("删除"),
      danger: true
    });
    if (!confirmed) return;
    const next = items.filter((entry) => entry.id !== item.id);
    saveCommandSnippets(next);
    setItems(next);
  };

  return (
    <div className="hb-pane hb-pad hb-stack">
      <div className="hb-pane__head">
        <div className="hb-pane__heading">
          <div className="hb-title">{t("快捷命令")}</div>
          <div className="hb-quiet">{t("点击只填入终端输入行，按 Enter 后才执行。")}</div>
        </div>
        <div className="hb-pane__actions">
          <Button size="sm" variant={editorOpen ? "ghost" : "secondary"} icon={editorOpen ? "close-outline" : "plus-outline"} onClick={() => setEditorOpen((value) => !value)}>
            {editorOpen ? t("收起") : t("自定义")}
          </Button>
        </div>
      </div>

      {editorOpen && (
        <div className="hb-card">
          <div className="hb-card__body" style={{ gap: 10 }}>
            <div className="hb-grid hb-grid--2">
              <Field label={t("名称")}>
                <TextInput value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t("查看 nginx 状态")} />
              </Field>
              <Field label={t("适用范围")}>
                <Select
                  value={form.scope}
                  onChange={(event) => setForm({ ...form, scope: event.target.value, scopeId: "" })}
                  options={[
                    { value: "global", label: t("所有服务器") },
                    { value: "group", label: t("指定分组") },
                    { value: "profile", label: t("指定服务器") }
                  ]}
                />
              </Field>
            </div>
            <Field label={t("命令")} hint={t("用 {{name}} 声明参数，填入时会先询问。")}>
              <TextInput className="hb-input--mono" value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} placeholder="systemctl status {{service}}" />
            </Field>
            {form.scope === "group" && (
              <Field label={t("分组")}>
                <Select
                  value={form.scopeId}
                  onChange={(event) => setForm({ ...form, scopeId: event.target.value })}
                  options={[{ value: "", label: t("选择分组") }, ...groups.map((group) => ({ value: group.groupId, label: group.name }))]}
                />
              </Field>
 )}
            {form.scope === "profile" && (
              <Field label={t("服务器")}>
                <Select
                  value={form.scopeId}
                  onChange={(event) => setForm({ ...form, scopeId: event.target.value })}
                  options={[{ value: "", label: t("选择服务器") }, ...profiles.map((profile) => ({ value: profile.profileId, label: profile.name || profile.host }))]}
                />
              </Field>
 )}
            <div className="hb-inline">
              <span className="hb-spacer" />
              <Button variant="secondary" size="sm" onClick={() => setEditorOpen(false)}>{t("取消")}</Button>
              <Button variant="primary" size="sm" icon="save-outline" onClick={save}>{t("保存")}</Button>
            </div>
          </div>
        </div>
 )}

      <div className="hb-inputgroup">
        <span className="hb-inputgroup__icon"><Icon name="search-outline" size={14} /></span>
        <input
          ref={searchRef}
          className="hb-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("搜索名称或命令，例如：nginx、日志、docker…")}
        />
      </div>

      {active === null && <div className="hb-notice"><Icon name="info-outline" size={14} />{t("请先连接服务器；你仍可浏览和搜索内置命令。")}</div>}

      {draft !== null && (
        <SnippetParameterForm
          key={draft.item.id}
          draft={draft}
          onCancel={() => setDraft(null)}
          onFill={(command) => fill(command, draft.sessionId)}
        />
 )}

      <div className="hb-scroll hb-fill hb-list hb-list--divided">
        {visible.map((item) => (
          <Row
            key={item.id}
            title={
              <>
                {item.name}
                {item.builtIn !== true && <Badge tone="accent">{t("自定义")}</Badge>}
              </>
            }
            meta={<code className="hb-mono hb-truncate hb-snippet__cmd">{item.command}</code>}
            actions={item.builtIn === true ? undefined : (
              <IconButton
                icon="trash-outline"
                label={t(`删除 ${item.name}`)}
                size="sm"
                danger
                onClick={() => void remove(item)}
              />
            )}
            onClick={() => choose(item)}
          />
 ))}
        {visible.length === 0 && (
          <EmptyState
            icon="checklist-outline"
            title={t("没有匹配的快捷命令")}
            text={t("换个关键词，或点右上角“自定义”添加一条。")}
          />
 )}
      </div>
    </div>
 );
}

function SnippetParameterForm({ draft, onCancel, onFill }) {
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const preview = expandSnippet(draft.item.command, values);
  const complete = draft.parameters.every((name) => Object.hasOwn(values, name) && values[name].trim() !== "");

  const submit = async (event) => {
    event.preventDefault();
    if (preview === null || busy) return;
    setBusy(true);
    try { await onFill(preview); } finally { setBusy(false); }
  };

  return (
    <form
      className="hb-card"
      onSubmit={submit}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } }}
    >
      <div className="hb-card__body" style={{ gap: 10 }}>
        <div className="hb-inline">
          <Icon name="list-pen-outline" size={14} />
          <span className="hb-strong">{draft.item.name}</span>
          <span className="hb-spacer" />
          <IconButton icon="close-outline" label={t("取消")} size="sm" onClick={onCancel} />
        </div>
        <div className="hb-grid hb-grid--2">
          {draft.parameters.map((name, index) => (
            <Field key={name} label={name}>
              <TextInput
                value={Object.hasOwn(values, name) ? values[name] : ""}
                onChange={(event) => setValues({ ...values, [name]: event.target.value })}
                autoFocus={index === 0}
                required
              />
            </Field>
 ))}
        </div>
        {preview === null && complete && (
          <span className="hb-field__error" role="alert">{t("参数占位符必须放在引号外，命令和参数不能包含控制字符。")}</span>
 )}
        {preview !== null && (
          <Field label={t("命令预览")}>
            <output className="hb-input hb-input--mono" style={{ height: "auto", padding: "8px 12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", display: "block" }}>{preview}</output>
          </Field>
 )}
        <div className="hb-inline">
          <span className="hb-spacer" />
          <Button type="submit" variant="primary" size="sm" icon="terminal" busy={busy} disabled={preview === null}>{t("填入终端")}</Button>
        </div>
      </div>
    </form>
 );
}