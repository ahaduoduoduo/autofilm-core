import { FormEvent, useEffect, useState } from "react";
import type {
  ExternalIdentity,
  MemberSummary,
  SessionUser,
  UserRole,
} from "@autofilm/contracts";
import {
  CirclePlus,
  Link2,
  MessageCircleWarning,
  Pencil,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import { api, jsonBody } from "../lib/api.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Toggle,
} from "../components/Ui.js";
import { useToast } from "../components/Toast.js";

export function MembersPage({ user }: { user: SessionUser }) {
  const { notify } = useToast();
  const [members, setMembers] = useState<MemberSummary[] | null>(null);
  const [identities, setIdentities] = useState<ExternalIdentity[]>([]);
  const [editing, setEditing] = useState<Partial<MemberSummary> | null>(null);
  const [binding, setBinding] = useState<ExternalIdentity | null>(null);

  async function load() {
    const [memberList, identityList] = await Promise.all([
      api<MemberSummary[]>("/api/admin/members"),
      api<ExternalIdentity[]>("/api/admin/identities"),
    ]);
    setMembers(memberList);
    setIdentities(identityList);
  }
  useEffect(() => void load(), []);

  if (!members) return <Loading />;
  const pending = identities.filter((identity) => identity.status === "pending");
  return (
    <div>
      <PageHeader
        eyebrow="ACCESS"
        title="成员与身份"
        description="一个成员可绑定多个微信、Telegram 或其他聊天身份；未绑定身份默认不能使用 Agent。"
        actions={
          <Button onClick={() => setEditing({ role: "member", status: "active" })}>
            <CirclePlus size={17} /> 添加成员
          </Button>
        }
      />
      {pending.length > 0 && (
        <Card className="pending-card">
          <div className="pending-icon">
            <MessageCircleWarning size={21} />
          </div>
          <div className="pending-copy">
            <strong>{pending.length} 个聊天身份等待处理</strong>
            <span>
              新联系人首次向 Adapter 发消息后会出现在这里，不会自动获得权限。
            </span>
          </div>
          <div className="pending-list">
            {pending.slice(0, 4).map((identity) => (
              <button
                key={identity.id}
                onClick={() => setBinding(identity)}
                className="pending-user"
              >
                <span className="avatar small">
                  {(identity.displayName || identity.externalUserId)
                    .slice(0, 1)
                    .toUpperCase()}
                </span>
                <span>
                  <strong>{identity.displayName || "未命名联系人"}</strong>
                  <small>
                    {identity.channel} · {identity.externalUserId}
                  </small>
                </span>
                <Link2 size={16} />
              </button>
            ))}
          </div>
        </Card>
      )}
      <Card className="table-card">
        {members.length ? (
          <div className="data-table">
            <div className="data-row data-head member-row">
              <span>成员</span>
              <span>角色</span>
              <span>聊天身份</span>
              <span>状态</span>
              <span />
            </div>
            {members.map((member) => (
              <div className="data-row member-row" key={member.id}>
                <span className="member-cell">
                  <span className="avatar">
                    {member.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{member.displayName}</strong>
                    <small>@{member.username}</small>
                  </span>
                </span>
                <span>
                  <Badge tone={member.role === "owner" ? "accent" : "neutral"}>
                    {member.role === "owner" && <ShieldCheck size={12} />}
                    {roleName(member.role)}
                  </Badge>
                </span>
                <span className="identity-chips">
                  {member.identities.length ? (
                    member.identities.map((identity) => (
                      <button
                        key={identity.id}
                        className="identity-chip"
                        onClick={() => setBinding(identity)}
                      >
                        {identity.channel}
                      </button>
                    ))
                  ) : (
                    <span className="muted">尚未绑定</span>
                  )}
                </span>
                <Badge tone={member.status === "active" ? "success" : "danger"}>
                  {member.status === "active" ? "正常" : "已停用"}
                </Badge>
                <span className="row-actions">
                  <Button
                    variant="ghost"
                    onClick={() => setEditing(member)}
                    disabled={member.id === user.id && user.role !== "owner"}
                  >
                    <Pencil size={15} />
                  </Button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Users size={24} />}
            title="还没有成员"
            description="创建成员后，再将聊天 Adapter 发现的外部身份绑定到成员。"
          />
        )}
      </Card>
      <div className="member-footnote">
        <UserRound size={16} />
        普通成员不需要 Web 密码即可通过已绑定聊天身份使用 Agent；Web
        密码仅在成员需要登录管理页面时设置。
      </div>
      {editing && (
        <MemberModal
          value={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            notify("成员资料已保存");
          }}
        />
      )}
      {binding && (
        <IdentityModal
          identity={binding}
          members={members}
          onClose={() => setBinding(null)}
          onSaved={async () => {
            setBinding(null);
            await load();
            notify("聊天身份已更新");
          }}
        />
      )}
    </div>
  );
}

function MemberModal({
  value,
  onClose,
  onSaved,
}: {
  value: Partial<MemberSummary>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { notify } = useToast();
  const [username, setUsername] = useState(value.username ?? "");
  const [displayName, setDisplayName] = useState(value.displayName ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>(value.role ?? "member");
  const [active, setActive] = useState(value.status !== "disabled");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      if (value.id) {
        await api(`/api/admin/members/${value.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            displayName,
            password: password || undefined,
            role,
            status: active ? "active" : "disabled",
          }),
        });
      } else {
        await api(
          "/api/admin/members",
          jsonBody({
            username,
            displayName,
            password: password || undefined,
            role,
          }),
        );
      }
      await onSaved();
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败", "error");
    }
  }
  return (
    <Modal title={value.id ? "编辑成员" : "添加成员"} onClose={onClose}>
      <form className="modal-body form-stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="用户名">
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={Boolean(value.id)}
              required
            />
          </Field>
          <Field label="显示名称">
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="角色">
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
            >
              <option value="member">成员</option>
              <option value="admin">管理员</option>
              <option value="owner">所有者</option>
            </Select>
          </Field>
          <Field
            label={value.id ? "新密码" : "Web 登录密码"}
            hint={value.id ? "留空表示不修改" : "可选；设置时至少 12 个字符"}
          >
            <Input
              type="password"
              value={password}
              minLength={password ? 12 : undefined}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </div>
        {value.id && (
          <Toggle checked={active} onChange={setActive} label="允许此成员使用服务" />
        )}
        <div className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button>保存成员</Button>
        </div>
      </form>
    </Modal>
  );
}

function IdentityModal({
  identity,
  members,
  onClose,
  onSaved,
}: {
  identity: ExternalIdentity;
  members: MemberSummary[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { notify } = useToast();
  const [userId, setUserId] = useState(identity.userId ?? "");
  const [status, setStatus] = useState<ExternalIdentity["status"]>(
    identity.status,
  );
  async function save() {
    try {
      await api(`/api/admin/identities/${identity.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          userId: userId || null,
          status,
        }),
      });
      await onSaved();
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败", "error");
    }
  }
  return (
    <Modal title="处理聊天身份" onClose={onClose}>
      <div className="modal-body form-stack">
        <div className="identity-summary">
          <span className="avatar">
            {(identity.displayName || identity.externalUserId)
              .slice(0, 1)
              .toUpperCase()}
          </span>
          <div>
            <strong>{identity.displayName || "未命名联系人"}</strong>
            <span>
              {identity.channel} / {identity.providerInstanceId} /{" "}
              {identity.externalUserId}
            </span>
          </div>
        </div>
        <Field label="绑定成员">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">不绑定</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName} (@{member.username})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="访问状态">
          <Select
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as ExternalIdentity["status"])
            }
          >
            <option value="pending">待处理</option>
            <option value="active">允许</option>
            <option value="blocked">阻止</option>
          </Select>
        </Field>
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={status === "active" && !userId}>
            保存绑定
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function roleName(role: UserRole): string {
  const names: Record<UserRole, string> = {
    owner: "所有者",
    admin: "管理员",
    member: "成员",
  };
  return names[role] ?? role;
}
