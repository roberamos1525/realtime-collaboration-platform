import { ROLES, canAssignRole, canRemoveMember, can, type MemberDto, type PublicUser, type Role, type WorkspaceDto } from "@rcp/shared";
import { useEffect, useState, type FormEvent } from "react";
import { errorMessage } from "../lib/api";
import { Avatar, ErrorBanner, RoleBadge } from "../components/ui";
import { useApp, useSessionUser } from "../state/app";

type AssignableRole = Exclude<Role, "owner">;
const ASSIGNABLE = ROLES.filter((r): r is AssignableRole => r !== "owner");

export function MembersPanel({
  workspace,
  members,
  onChanged,
  onLeft,
}: {
  workspace: WorkspaceDto;
  members: MemberDto[];
  onChanged: () => void;
  onLeft: () => void;
}) {
  const { api } = useApp();
  const me = useSessionUser();
  const [identifier, setIdentifier] = useState("");
  const [role, setRole] = useState<AssignableRole>("editor");
  const [suggestions, setSuggestions] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const canManage = can(workspace.role, "member.manage");

  useEffect(() => {
    const q = identifier.trim();
    if (q.length < 2 || q.includes("@")) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .searchUsers(q)
        .then((users) => !cancelled && setSuggestions(users.filter((u) => !members.some((m) => m.user.id === u.id))))
        .catch(() => !cancelled && setSuggestions([]));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, identifier, members]);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.addMember(workspace.id, identifier.trim(), role);
      setIdentifier("");
    });
  };

  return (
    <section>
      <div className="section-header">
        <h2>Members</h2>
      </div>
      <ErrorBanner message={error} />
      {canManage && (
        <form className="inline-form" onSubmit={add}>
          <div className="autocomplete">
            <input
              placeholder="Username or e-mail"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              aria-label="User to add"
              list="member-suggestions"
            />
            <datalist id="member-suggestions">
              {suggestions.map((u) => (
                <option key={u.id} value={u.username}>
                  {u.displayName}
                </option>
              ))}
            </datalist>
          </div>
          <select value={role} onChange={(e) => setRole(e.target.value as AssignableRole)} aria-label="Role">
            {ASSIGNABLE.filter((r) => canAssignRole(workspace.role, null, r)).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button type="submit" className="primary" disabled={identifier.trim().length < 3}>
            Add member
          </button>
        </form>
      )}
      <ul className="member-list">
        {members.map((m) => {
          const isSelf = m.user.id === me?.id;
          const roleOptions = ASSIGNABLE.filter((r) => canAssignRole(workspace.role, m.role, r));
          return (
            <li key={m.user.id} className="member-row">
              <Avatar userId={m.user.id} name={m.user.displayName} size={34} />
              <div className="member-main">
                <strong>
                  {m.user.displayName} {isSelf && <span className="muted">(you)</span>}
                </strong>
                <span className="muted">@{m.user.username}</span>
              </div>
              {!isSelf && roleOptions.length > 0 ? (
                <select
                  value={m.role}
                  aria-label={`Role of ${m.user.displayName}`}
                  onChange={(e) => void run(() => api.changeRole(workspace.id, m.user.id, e.target.value as AssignableRole))}
                >
                  {[m.role, ...roleOptions.filter((r) => r !== m.role)].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ) : (
                <RoleBadge role={m.role} />
              )}
              {canRemoveMember(workspace.role, m.role, isSelf) && (
                <button
                  type="button"
                  className="danger-link"
                  onClick={() =>
                    void run(async () => {
                      if (!window.confirm(isSelf ? "Leave this workspace?" : `Remove ${m.user.displayName}?`)) return;
                      await api.removeMember(workspace.id, m.user.id);
                      if (isSelf) onLeft();
                    })
                  }
                >
                  {isSelf ? "Leave" : "Remove"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
