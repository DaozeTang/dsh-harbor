/**
 * Offline preview harness.
 *
 * It mounts the real kit against a mock host so the workbench can be looked at
 * — and screenshotted — without a running Harness: same components, same
 * stylesheet, same tokens the host injects. Nothing here ships in the plugin
 * bundle; `npm run preview:ui` builds it into preview/out.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  Badge, Button, Card, Checkbox, Dialog, Dot, EmptyState, ErrorNote, Field, Icon, IconButton,
  InputGroup, Menu, MenuItem, MenuSeparator, Notice, Pill, ProgressBar, Row, Section,
  SegmentedControl, Select, Spinner, Switch, Tabs, TextArea, TextInput, ToastHost, toast
} from "../src/client/ui/kit.jsx";
import { installStyles } from "../src/client/ui/styles.js";

const { useState, useRef } = React;

installStyles();

function Gallery() {
  const [dialog, setDialog] = useState(false);
  const [menu, setMenu] = useState(false);
  const [seg, setSeg] = useState("terminal");
  const [tab, setTab] = useState("terminal");
  const [on, setOn] = useState(true);
  const [check, setCheck] = useState(true);
  const [query, setQuery] = useState("");
  const anchor = useRef(null);

  return (
    <div className="hb" style={{ height: "auto", padding: 24, gap: 20, overflow: "visible" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div className="hb-avatar"><Icon name="terminal" size={16} /></div>
        <div>
          <div className="hb-page__title">Harbor</div>
          <div className="hb-caption">Design system · light surface</div>
        </div>
      </header>

      <Card title="Buttons" description="one primary per surface">
        <div className="hb-inline hb-inline--wrap">
          <Button variant="primary">连接服务器</Button>
          <Button variant="secondary">新建分组</Button>
          <Button variant="ghost">取消</Button>
          <Button variant="danger">删除</Button>
          <Button variant="primary" busy>连接中</Button>
          <Button variant="secondary" disabled>不可用</Button>
        </div>
        <div className="hb-inline hb-inline--wrap">
          <Button size="sm" variant="secondary" icon="plus-outline">小号</Button>
          <Button size="sm" icon="refresh-outline">刷新</Button>
          <IconButton icon="settings-outline" label="设置" />
          <IconButton icon="search-outline" label="搜索" active />
          <IconButton icon="trash-outline" label="删除" danger />
        </div>
      </Card>

      <Card title="Fields">
        <div className="hb-grid hb-grid--2">
          <Field label="主机" hint="域名或 IP">
            <TextInput placeholder="10.0.0.12" />
          </Field>
          <Field label="端口">
            <TextInput defaultValue="22" />
          </Field>
          <Field label="认证方式">
            <Select options={[{ value: "password", label: "密码" }, { value: "key", label: "私钥" }]} />
          </Field>
          <Field label="连接失败" error="连接被拒绝 (ECONNREFUSED)">
            <TextInput invalid defaultValue="10.0.0.12" />
          </Field>
        </div>
        <InputGroup icon="search-outline">
          <TextInput placeholder="搜索服务器、地址或分组" value={query} onChange={(e) => setQuery(e.target.value)} />
        </InputGroup>
        <TextArea placeholder="登录命令，例如 bash -l" />
        <div className="hb-inline" style={{ gap: 20 }}>
          <Switch checked={on} onChange={setOn} label="跟随 DSH 语言" />
          <Checkbox checked={check} onChange={setCheck} label="记住这次选择" />
        </div>
        <SegmentedControl
          value={seg}
          onChange={setSeg}
          items={[
            { value: "terminal", label: "终端", icon: "terminal" },
            { value: "files", label: "文件", icon: "folder-open-outline" },
            { value: "logs", label: "日志", icon: "archive-outline" }
          ]}
        />
      </Card>

      <Card title="Data">
        <div className="hb-inline hb-inline--wrap">
          <Badge tone="ok">已连接</Badge>
          <Badge tone="warn">等待输入</Badge>
          <Badge tone="err">失败</Badge>
          <Badge tone="accent">Agent</Badge>
          <Badge mono>SHA256:9f2c…</Badge>
          <Pill icon="globe-outline">prod-web-01</Pill>
          <span className="hb-inline"><Dot tone="ok" />运行中</span>
          <span className="hb-inline"><Dot tone="busy" />连接中</span>
        </div>
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "terminal", label: "终端" },
            { value: "files", label: "文件" },
            { value: "tunnels", label: "转发", count: 2 },
            { value: "logs", label: "日志" }
          ]}
        />
        <div className="hb-tablewrap" style={{ maxHeight: 180 }}>
          <table className="hb-table">
            <thead>
              <tr><th>id</th><th>email</th><th>created_at</th><th>plan</th></tr>
            </thead>
            <tbody>
              {[
                [1, "ada@example.com", "2026-03-02 09:14:22", "pro"],
                [2, "lin@example.com", "2026-03-04 18:02:11", "free"],
                [3, "mo@example.com", "2026-03-09 07:41:03", "team"]
              ].map((r) => (
                <tr key={r[0]}><td>{r[0]}</td><td>{r[1]}</td><td className="hb-mono">{r[2]}</td><td>{r[3]}</td></tr>
 ))}
              <tr><td>4</td><td className="hb-null">NULL</td><td className="hb-mono">—</td><td>free</td></tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="States">
        <div className="hb-stack">
          <ErrorNote>远端主机不可达：连接超时（10.0.0.12:22）</ErrorNote>
          <Notice>批准删除会把文件移入远端回收站 ~/.dsh-trash，可随时恢复。</Notice>
          <div className="hb-inline" style={{ gap: 12 }}>
            <Spinner label="loading" />
            <span className="hb-caption">正在读取 /var/log/nginx</span>
            <span className="hb-spacer" />
            <div style={{ width: 200 }}><ProgressBar value={62} max={100} /></div>
          </div>
        </div>
      </Card>

      <Card title="Rows">
        <Row
          leading={<div className="hb-avatar">p</div>}
          title={<span>prod-web-01 <Badge tone="ok">已连接</Badge></span>}
          meta={<span>10.0.0.12 · root · 共享凭据「prod key」</span>}
          actions={<><IconButton icon="play-outline" label="连接" /><IconButton icon="ellipsis-outline" label="更多" /></>}
          onClick={() => toast("打开 prod-web-01")}
        />
        <Row
          leading={<div className="hb-avatar">s</div>}
          title="staging-db"
          meta="10.0.0.31 · ubuntu · 密码"
          actions={<IconButton icon="play-outline" label="连接" />}
          onClick={() => {}}
        />
      </Card>

      <Section title="Interactions">
        <div className="hb-inline">
          <Button variant="secondary" onClick={() => setDialog(true)}>打开对话框</Button>
          <Button variant="secondary" ref={anchor} onClick={() => setMenu(!menu)}>更多操作</Button>
          <Button variant="secondary" onClick={() => toast("已保存服务器配置")}>提示</Button>
          <Button variant="secondary" onClick={() => toast("保存失败：凭据不存在", { tone: "error" })}>错误提示</Button>
        </div>
      </Section>

      <div style={{ height: 320 }}>
        <div className="hb-card" style={{ height: "100%" }}>
          <div className="hb-card__body" style={{ flex: 1 }}>
            <EmptyState
              icon="terminal"
              title="还没有打开终端"
              text="连接一台服务器即可开始。已保存的服务器会复用凭据，不会把密码写进对话。"
              action={<Button variant="primary" icon="plus-outline">连接服务器</Button>}
            />
          </div>
        </div>
      </div>

      <Menu open={menu} anchorRef={anchor} onClose={() => setMenu(false)}>
        <MenuItem icon="play-outline" onSelect={() => { setMenu(false); toast("已连接"); }}>连接</MenuItem>
        <MenuItem icon="edit-outline" onSelect={() => setMenu(false)}>编辑</MenuItem>
        <MenuItem icon="copy-outline" onSelect={() => setMenu(false)}>复制地址</MenuItem>
        <MenuSeparator />
        <MenuItem icon="trash-outline" danger onSelect={() => setMenu(false)}>删除</MenuItem>
      </Menu>

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="新建服务器"
        description="凭据会写入 DSH 的本机凭据库，不会出现在对话里。"
        footer={<>
          <Button variant="secondary" onClick={() => setDialog(false)}>取消</Button>
          <Button variant="primary" data-modal-autofocus onClick={() => { setDialog(false); toast("已保存"); }}>保存</Button>
        </>}
      >
        <div className="hb-stack">
          <div className="hb-grid hb-grid--2">
            <Field label="名称"><TextInput placeholder="prod-web-01" /></Field>
            <Field label="分组"><Select options={["未分组", "生产", "测试"]} /></Field>
            <Field label="主机"><TextInput placeholder="10.0.0.12" /></Field>
            <Field label="端口"><TextInput defaultValue="22" /></Field>
          </div>
          <Field label="认证"><SegmentedControl value="password" onChange={() => {}} items={[{ value: "password", label: "密码" }, { value: "key", label: "私钥" }]} /></Field>
        </div>
      </Dialog>

      <ToastHost />
    </div>
 );
}

/** A mock of the workbench shell, so layout decisions are reviewable too. */
function ShellPreview() {
  return (
    <div className="hb" style={{ height: 520, border: "1px solid var(--hb-border)", borderRadius: 12, overflow: "hidden" }}>
      <div className="hb-toolbar">
        <div className="hb-servers">
          <div className="hb-server" data-active="true">
            <Dot tone="ok" />
            <span className="hb-server__label">prod-web-01</span>
            <span className="hb-server__close"><Icon name="close-outline" size={12} /></span>
          </div>
          <div className="hb-server">
            <Dot tone="warn" />
            <span className="hb-server__label">staging-db</span>
          </div>
        </div>
        <div className="hb-views">
          <IconButton icon="plus-outline" label="连接服务器" />
          <IconButton icon="terminal" label="终端" active />
        </div>
      </div>
      <div className="hb-tabs" style={{ padding: "0 8px" }}>
        <button className="hb-tab" aria-selected="true"><Icon name="terminal" size={14} />终端</button>
        <button className="hb-tab" aria-selected="false"><Icon name="folder-open-outline" size={14} />文件</button>
        <button className="hb-tab" aria-selected="false"><Icon name="tunnel" size={14} />转发</button>
        <button className="hb-tab" aria-selected="false"><Icon name="checklist-outline" size={14} />快捷命令</button>
      </div>
      <div className="hb-body">
        <div className="hb-pane">
          <div className="hb-term">
            <div className="hb-term__host" style={{ fontFamily: "var(--hb-mono)", fontSize: 12, lineHeight: 1.6, color: "var(--hb-text-secondary)" }}>
              <div><span style={{ color: "#3fa65c" }}>root@prod-web-01</span>:<span style={{ color: "#4176e6" }}>~</span>$ uptime</div>
              <div> 10:24:03 up 42 days,  3:11,  1 user,  load average: 0.08, 0.12, 0.09</div>
              <div><span style={{ color: "#3fa65c" }}>root@prod-web-01</span>:<span style={{ color: "#4176e6" }}>~</span>$ <span style={{ opacity: 0.5 }}>▍</span></div>
            </div>
            <div className="hb-term__overlay">
              <IconButton icon="search-outline" label="查找" size="sm" />
              <IconButton icon="chevron-down-outline" label="跳到底部" size="sm" />
            </div>
          </div>
        </div>
      </div>
    </div>
 );
}

const root = createRoot(document.getElementById("root"));
root.render(<div className="hb" style={{ height: "auto", gap: 18, padding: 24 }}>
  <Gallery />
  <Section title="Workspace shell"><ShellPreview /></Section>
</div>);

document.body.dataset.ready = "true";
