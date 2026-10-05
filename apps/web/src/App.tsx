import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ApiClient,
  ApiError,
  type Breadcrumb,
  type AdminGroup,
  type AdminUser,
  type CollectionItem,
  type CurrentUser,
  type DocumentRole,
  type EditorSession,
  type FileVersion,
  type Node,
  type PermissionEntry,
  type PreviewSession,
  type PermissionsState,
  type SearchItem,
  type SharingPrincipal,
  type SharingState,
  type SystemRole,
  type TrashItem,
} from "./api";
import "./App.css";

const api = new ApiClient();
type Notice = { tone: "error" | "success"; message: string } | null;
type AvailablePreview = PreviewSession & { canDownload: boolean };
type UnavailablePreview = {
  unavailable: true;
  nodeId: string;
  filename: string;
  canDownload: boolean;
};
type Preview = AvailablePreview | UnavailablePreview;

function previewIsUnavailable(preview: Preview): preview is UnavailablePreview {
  return "unavailable" in preview;
}

function currentFolderId() {
  return (
    window.location.pathname.match(/^\/drive\/([0-9a-f-]+)$/i)?.[1] ?? null
  );
}
function currentRoute() {
  if (window.location.pathname === "/admin") return "admin";
  if (window.location.pathname === "/profile") return "profile";
  if (window.location.pathname === "/trash") return "trash";
  if (window.location.pathname === "/search") return "search";
  if (window.location.pathname === "/recent") return "recent";
  if (window.location.pathname === "/favorites") return "favorites";
  return "drive";
}
function currentAdminTab(): "users" | "groups" {
  return new URLSearchParams(window.location.search).get("tab") === "groups"
    ? "groups"
    : "users";
}
function navigateAdmin(tab: "users" | "groups" = "users") {
  const path = `/admin${tab === "users" ? "" : "?tab=groups"}`;
  if (`${window.location.pathname}${window.location.search}` !== path) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
function navigateProfile() {
  if (window.location.pathname !== "/profile") {
    window.history.pushState({}, "", "/profile");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
function currentSearchQuery() {
  return new URLSearchParams(window.location.search).get("q") ?? "";
}
function navigate(folderId: string | null) {
  const path = folderId ? `/drive/${folderId}` : "/drive";
  if (window.location.pathname !== path) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
function navigateTrash() {
  if (window.location.pathname !== "/trash") {
    window.history.pushState({}, "", "/trash");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
function navigateCollection(route: "recent" | "favorites") {
  const path = `/${route}`;
  if (window.location.pathname !== path) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
function navigateSearch(query: string) {
  const parameters = new URLSearchParams();
  if (query) parameters.set("q", query);
  const path = `/search${parameters.size ? `?${parameters}` : ""}`;
  if (`${window.location.pathname}${window.location.search}` !== path) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
function displayError(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : "Something went wrong. Please try again.";
}
function hasCapability(node: Node, capability: string) {
  return node.capabilities.includes(capability);
}
function isOnlyOfficeEditableFile(name: string) {
  return /\.(doc|docx|xls|xlsx|ppt|pptx)$/i.test(name);
}
async function openFileActivation(
  node: Node,
  setEditor: (session: EditorSession) => void,
  setPreview: (preview: Preview) => void,
  onError: (notice: Notice) => void,
) {
  try {
    if (isOnlyOfficeEditableFile(node.name) && hasCapability(node, "PREVIEW")) {
      setEditor(await api.createEditorSession(node.id, "VIEW"));
      return;
    }
    if (hasCapability(node, "PREVIEW")) {
      const session = await api.createPreviewSession(node.id);
      if (session) {
        setPreview({ ...session, canDownload: hasCapability(node, "DOWNLOAD") });
        return;
      }
      setPreview({
        unavailable: true,
        nodeId: node.id,
        filename: node.name,
        canDownload: hasCapability(node, "DOWNLOAD"),
      });
      return;
    }
    if (hasCapability(node, "DOWNLOAD")) await api.download(node);
  } catch (error) {
    onError({ tone: "error", message: displayError(error) });
  }
}
async function openEditorForEdit(
  node: Node,
  setEditor: (session: EditorSession) => void,
  onError: (notice: Notice) => void,
) {
  try {
    if (!isOnlyOfficeEditableFile(node.name) || !hasCapability(node, "EDIT")) {
      onError({ tone: "error", message: "You cannot edit this document." });
      return;
    }
    setEditor(await api.createEditorSession(node.id, "EDIT"));
  } catch (error) {
    onError({ tone: "error", message: displayError(error) });
  }
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "—"
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year:
          date.getFullYear() === new Date().getFullYear()
            ? undefined
            : "numeric",
      }).format(date);
}
function formatBytes(value: string) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatVersionSource(source: FileVersion["source"]) {
  return source.charAt(0) + source.slice(1).toLowerCase();
}
function compareNodes(left: Node, right: Node) {
  return left.type === right.type
    ? left.name.localeCompare(right.name)
    : left.type === "FOLDER"
      ? -1
      : 1;
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    folder: (
      <path d="M3.5 6.5h6l1.7 2H20a1 1 0 0 1 1 1v8.75a1.75 1.75 0 0 1-1.75 1.75h-14.5A1.75 1.75 0 0 1 3 18.25v-10A1.75 1.75 0 0 1 4.75 6.5Z" />
    ),
    file: (
      <>
        <path d="M6 2.75h7.6L19 8.1v12.15A1.75 1.75 0 0 1 17.25 22h-11.5A1.75 1.75 0 0 1 4 20.25V4.75A2 2 0 0 1 6 2.75Z" />
        <path d="M13.25 2.9v5.35H18.7M7.75 13h7.5M7.75 16.5h7.5" />
      </>
    ),
    drive: (
      <>
        <path d="m12 3 8 14H4L12 3Z" />
        <path d="m12 3 4 7H8l4-7ZM8 10l4 7 4-7" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    upload: (
      <>
        <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5" />
        <path d="M4 15.5v3.75A1.75 1.75 0 0 0 5.75 21h12.5A1.75 1.75 0 0 0 20 19.25V15.5" />
      </>
    ),
    more: (
      <path
        d="M6.5 12h.01M12 12h.01M17.5 12h.01"
        strokeWidth="3"
        strokeLinecap="round"
      />
    ),
    chevron: <path d="m9 18 6-6-6-6" />,
    "chevron-down": <path d="m6 9 6 6 6-6" />,
    settings: <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.7 1.7-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-2.4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-1.7-1.7.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H6.7v-2.4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L8 8.6l1.7-1.7.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.2h2.4v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.7 1.7-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2V14h-.2a1.7 1.7 0 0 0-1.5 1Z" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    refresh: (
      <>
        <path d="M20 11a8 8 0 0 0-14.8-4.2L3 9" />
        <path d="M3 4v5h5M4 13a8 8 0 0 0 14.8 4.2L21 15" />
        <path d="M21 20v-5h-5" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5" />
        <path d="M4 19.5v.75A1.75 1.75 0 0 0 5.75 22h12.5A1.75 1.75 0 0 0 20 20.25v-.75" />
      </>
    ),
    edit: (
      <path d="m14.5 5.5 4 4M4 20l4.2-1 10.9-10.9a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z" />
    ),
    share: (
      <>
        <circle cx="8" cy="12" r="2.25" />
        <circle cx="16.5" cy="6.5" r="2.25" />
        <circle cx="16.5" cy="17.5" r="2.25" />
        <path d="m10 10.8 4.4-3M10 13.2l4.4 3" />
      </>
    ),
    trash: (
      <>
        <path d="M5 7h14M9 7V4.5h6V7M7.5 7l.7 13h7.6l.7-13M10 10.5v6M14 10.5v6" />
      </>
    ),
    link: (
      <>
        <path d="M10.2 13.8a4 4 0 0 0 5.6.1l2-2a4 4 0 0 0-5.7-5.6l-1.1 1.1" />
        <path d="M13.8 10.2a4 4 0 0 0-5.6-.1l-2 2a4 4 0 0 0 5.7 5.6l1.1-1.1" />
      </>
    ),
    search: <circle cx="10.8" cy="10.8" r="6.3" />,
    recent: (
      <>
        <circle cx="12" cy="12" r="8.25" />
        <path d="M12 7.5v4.8l3.1 1.9" />
      </>
    ),
    star: <path d="m12 3.6 2.55 5.16 5.7.83-4.13 4.03.98 5.68L12 16.62 6.9 19.3l.98-5.68-4.13-4.03 5.7-.83L12 3.6Z" />,
  };
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      {paths[name]}
      {name === "search" && <path d="m16 16 4.3 4.3" />}
    </svg>
  );
}

function Toast({
  notice,
  onDismiss,
}: {
  notice: Notice;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(onDismiss, 3200);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);
  if (!notice) return null;
  return createPortal(
    <div className="toast-viewport">
      <div
        className={`toast toast-${notice.tone}`}
        role={notice.tone === "error" ? "alert" : "status"}
      >
        <span>{notice.message}</span>
        <button type="button" aria-label="Dismiss notification" onClick={onDismiss}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>,
    document.body,
  );
}

function useDialogFocus() {
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
    const initial = dialog.current?.querySelector<HTMLElement>(
      "[data-dialog-initial-focus]",
    );
    (initial ?? focusable()[0])?.focus();

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      opener?.focus();
    };
  }, []);

  return dialog;
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [profile, setProfile] = useState<CurrentUser | null>(null);
  const [location, setLocation] = useState(() => ({
    route: currentRoute(),
    searchQuery: currentSearchQuery(),
    adminTab: currentAdminTab(),
  }));
  useEffect(() => {
    let active = true;
    void api.refresh().then(
      () => api.currentUser(),
    ).then(
      (user) => {
        if (!active) return;
        if (
          !/^(?:\/drive(?:\/[0-9a-f-]+)?|\/trash|\/search|\/recent|\/favorites|\/admin|\/profile)$/i.test(
            window.location.pathname,
          )
        ) window.history.replaceState({}, "", "/drive");
        setLocation({ route: currentRoute(), searchQuery: currentSearchQuery(), adminTab: currentAdminTab() });
        setProfile(user);
        setAuthenticated(true);
      },
      () => active && setAuthenticated(false),
    );
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const onPopState = () =>
      setLocation({ route: currentRoute(), searchQuery: currentSearchQuery(), adminTab: currentAdminTab() });
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  if (authenticated === null)
    return <div className="auth-state">Checking your session…</div>;
  if (!authenticated) return <SignIn />;
  if (!profile) return <div className="auth-state">Loading your account…</div>;
  const isAdmin = profile.status === "ACTIVE" && profile.systemRole === "ADMIN";
  async function signOut() {
    try {
      await api.logout();
    } finally {
      setAuthenticated(false);
      setProfile(null);
    }
  }
  let page: ReactNode;
  switch (location.route) {
    case "trash":
      page = <TrashApp />;
      break;
    case "search":
      page = <SearchApp query={location.searchQuery} />;
      break;
    case "recent":
      page = <CollectionApp kind="recent" />;
      break;
    case "favorites":
      page = <CollectionApp kind="favorites" />;
      break;
    case "admin":
      page = isAdmin ? <AdminApp tab={location.adminTab} /> : <AccessDenied />;
      break;
    case "profile":
      page = <ProfileApp profile={profile} onSignOut={() => void signOut()} />;
      break;
    default:
      page = <DriveApp systemRole={profile.systemRole} />;
  }
  const active: SidebarRoute = location.route === "drive" || location.route === "recent" || location.route === "favorites" || location.route === "trash"
    ? location.route
    : location.route === "admin" && isAdmin ? "admin" : null;
  return <AppShell profile={profile} active={active} onSignOut={() => void signOut()}>{page}</AppShell>;
}
function AccessDenied() {
  return <div className="content-state"><h1>You do not have access to administration.</h1><p>Ask an administrator if you need access.</p></div>;
}

function AdminApp({ tab }: { tab: "users" | "groups" }) {
  return <><PageHeader title={<h1 className="page-title">Admin</h1>} /><section className="admin-content" aria-label="Administration">
    <div className="admin-intro"><h2>Admin</h2><p>Manage users, groups, and access to Docs Hub.</p></div>
    <div className="admin-tabs" role="tablist" aria-label="Administration sections">
      <button type="button" role="tab" aria-selected={tab === "users"} className={tab === "users" ? "is-active" : ""} onClick={() => navigateAdmin("users")}>Users</button>
      <button type="button" role="tab" aria-selected={tab === "groups"} className={tab === "groups" ? "is-active" : ""} onClick={() => navigateAdmin("groups")}>Groups</button>
    </div>
    <div className="admin-tab-content">{tab === "users" ? <AdminUsers /> : <AdminGroups />}</div>
  </section></>;
}

function AdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const load = useCallback(async () => { try { setUsers((await api.listAdminUsers()).items); } catch (error) { setNotice({ tone: "error", message: displayError(error) }); } }, []);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  async function create(input: { email: string; displayName: string; systemRole: SystemRole }) {
    await api.createAdminUser(input);
    await load();
    setAddOpen(false);
    setNotice({ tone: "success", message: "User added. They can now sign in with this Google email." });
  }
  async function action(user: AdminUser, kind: "role" | "status") {
    if (kind === "status" && user.status !== "SUSPENDED" && !window.confirm(`Suspend ${user.displayName}? They will not be able to sign in.`)) return;
    setOpenMenuId(null);
    try { const updated = kind === "role" ? await api.updateAdminUser(user.id, { systemRole: user.systemRole === "ADMIN" ? "MEMBER" : "ADMIN" }) : user.status === "SUSPENDED" ? await api.reactivateAdminUser(user.id) : await api.suspendAdminUser(user.id); setUsers((items) => items.map((item) => item.id === user.id ? updated : item)); } catch (error) { setNotice({ tone: "error", message: displayError(error) }); }
  }
  const matching = users.filter((user) => `${user.displayName} ${user.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <Toast notice={notice} onDismiss={() => setNotice(null)} />
    <div className="admin-section-header"><div><h3>Users</h3><p>Manage who can access Docs Hub.</p></div><button type="button" className="button button-primary" onClick={() => setAddOpen(true)}><Icon name="plus" size={16} />Add user</button></div>
    <input className="admin-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search users…" aria-label="Search users" />
    <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>{matching.map((user) => <AdminUserRow key={user.id} user={user} menuOpen={openMenuId === user.id} onToggleMenu={() => setOpenMenuId((open) => open === user.id ? null : user.id)} onCloseMenu={() => setOpenMenuId(null)} onAction={(kind) => void action(user, kind)} />)}</tbody></table></div>
    {addOpen && <AddUserDialog onClose={() => setAddOpen(false)} onSubmit={create} />}
  </>;
}

function AdminUserRow({ user, menuOpen, onToggleMenu, onCloseMenu, onAction }: { user: AdminUser; menuOpen: boolean; onToggleMenu: () => void; onCloseMenu: () => void; onAction: (kind: "role" | "status") => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <tr><td>{user.displayName}</td><td>{user.email}</td><td>{user.systemRole === "ADMIN" ? "Administrator" : "Member"}</td><td>{user.status === "ACTIVE" ? "Active" : user.status === "SUSPENDED" ? "Suspended" : "Invited"}</td><td className="row-actions">
    <button ref={trigger} type="button" className="icon-button" aria-label={`Actions for ${user.displayName}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={onToggleMenu}><Icon name="more" /></button>
    {menuOpen && <RowMenu id={`admin-user-menu-${user.id}`} trigger={trigger} onClose={onCloseMenu}>
      <button type="button" role="menuitem" onClick={() => { onCloseMenu(); onAction("role"); }}>{user.systemRole === "ADMIN" ? "Make member" : "Make admin"}</button>
      <div className="row-menu-divider" />
      <button type="button" role="menuitem" className={user.status === "SUSPENDED" ? "" : "menu-danger"} onClick={() => { onCloseMenu(); onAction("status"); }}>{user.status === "SUSPENDED" ? "Reactivate" : "Suspend"}</button>
    </RowMenu>}
  </td></tr>;
}

function AddUserDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (input: { email: string; displayName: string; systemRole: SystemRole }) => Promise<void> }) {
  const dialog = useDialogFocus();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const displayName = String(form.get("displayName") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    const systemRole = String(form.get("systemRole") ?? "MEMBER") as SystemRole;
    if (!displayName || !email || !systemRole) {
      setError("Display name, email, and role are required.");
      return;
    }
    setError("");
    setPending(true);
    try {
      await onSubmit({ displayName, email, systemRole });
    } catch (requestError) {
      setError(displayError(requestError));
    } finally {
      setPending(false);
    }
  }
  return <div className="dialog-backdrop" role="presentation"><section ref={dialog} className="dialog admin-dialog" role="dialog" aria-modal="true" aria-labelledby="add-user-title">
    <header className="dialog-header"><div><h2 id="add-user-title">Add user</h2><p>Add a Google account to Docs Hub.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog"><Icon name="close" size={16} /></button></header>
    <form onSubmit={(event) => void submit(event)}>
      <label htmlFor="add-user-name">Display name</label><input id="add-user-name" name="displayName" required maxLength={200} data-dialog-initial-focus />
      <label htmlFor="add-user-email">Google email</label><input id="add-user-email" name="email" type="email" required maxLength={320} />
      <label htmlFor="add-user-role">Role</label><select id="add-user-role" name="systemRole" defaultValue="MEMBER" required><option value="MEMBER">Member</option><option value="ADMIN">Admin</option></select>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button" onClick={onClose} disabled={pending}>Cancel</button><button type="submit" className="button button-primary" disabled={pending}>{pending ? "Adding…" : "Add user"}</button></div>
    </form>
  </section></div>;
}

function AdminGroups() {
  const [groups, setGroups] = useState<AdminGroup[]>([]); const [members, setMembers] = useState<Record<string, AdminUser[]>>({}); const [users, setUsers] = useState<AdminUser[]>([]); const [query, setQuery] = useState(""); const [notice, setNotice] = useState<Notice>(null);
  const load = useCallback(async () => { try { const [groupPage, userPage] = await Promise.all([api.listAdminGroups(), api.listAdminUsers()]); setGroups(groupPage.items); setUsers(userPage.items); } catch (error) { setNotice({ tone: "error", message: displayError(error) }); } }, []); useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  async function create(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const name = String(new FormData(event.currentTarget).get("name")); try { const group = await api.createAdminGroup({ name }); setGroups((items) => [group, ...items]); event.currentTarget.reset(); } catch (error) { setNotice({ tone: "error", message: displayError(error) }); } }
  async function toggleMembers(group: AdminGroup) { if (!members[group.id]) { try { const page = await api.listAdminGroupMembers(group.id); setMembers((all) => ({ ...all, [group.id]: page.items.map((item) => item.user) })); } catch (error) { setNotice({ tone: "error", message: displayError(error) }); } } else setMembers((all) => { const next = { ...all }; delete next[group.id]; return next; }); }
  async function add(groupId: string, userId: string) { try { await api.addAdminGroupMember(groupId, userId); const page = await api.listAdminGroupMembers(groupId); setMembers((all) => ({ ...all, [groupId]: page.items.map((item) => item.user) })); } catch (error) { setNotice({ tone: "error", message: displayError(error) }); } }
  async function remove(groupId: string, userId: string) { try { await api.removeAdminGroupMember(groupId, userId); setMembers((all) => ({ ...all, [groupId]: (all[groupId] ?? []).filter((user) => user.id !== userId) })); } catch (error) { setNotice({ tone: "error", message: displayError(error) }); } }
  async function rename(group: AdminGroup) { const name = window.prompt("Group name", group.name); if (!name || name === group.name) return; try { const updated = await api.updateAdminGroup(group.id, { name }); setGroups((items) => items.map((item) => item.id === group.id ? updated : item)); } catch (error) { setNotice({ tone: "error", message: displayError(error) }); } }
  const matching = groups.filter((group) => group.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <><Toast notice={notice} onDismiss={() => setNotice(null)} /><div className="admin-section-header"><div><h3>Groups</h3><p>Organize users for document permissions.</p></div><form className="admin-inline-form" onSubmit={create}><input required name="name" placeholder="New group name" maxLength={200} aria-label="New group name" /><button className="button button-primary">New group</button></form></div><input className="admin-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search groups…" aria-label="Search groups" />{groups.length === 0 || matching.length === 0 ? <div className="admin-empty"><h3>{groups.length === 0 ? "No groups yet." : "No groups found."}</h3><p>{groups.length === 0 ? "Create a group to organize document permissions." : "Try a different search."}</p></div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Group name</th><th>Members</th><th>Actions</th></tr></thead><tbody>{matching.map((group) => <><tr key={group.id}><td>{group.name}</td><td>{group.memberCount}</td><td><button className="button" onClick={() => void rename(group)}>Rename</button><button className="button" onClick={() => void toggleMembers(group)}>{members[group.id] ? "Close members" : "Manage members"}</button></td></tr>{members[group.id] && <tr key={`${group.id}-members`}><td colSpan={3}><select defaultValue="" onChange={(event) => { if (event.target.value) void add(group.id, event.target.value); event.currentTarget.value = ""; }}><option value="">Add a user…</option>{users.filter((user) => !members[group.id].some((member) => member.id === user.id)).map((user) => <option key={user.id} value={user.id}>{user.displayName} — {user.email}</option>)}</select>{members[group.id].map((user) => <div className="admin-member" key={user.id}>{user.displayName} <button className="button" onClick={() => void remove(group.id, user.id)}>Remove</button></div>)}</td></tr>}</>)}</tbody></table></div>}
  </>;
}

function ProfileApp({ profile, onSignOut }: { profile: CurrentUser; onSignOut: () => void }) {
  return <>
    <PageHeader title={<h1 className="page-title">Profile</h1>} />
    <section className="profile-content" aria-label="Profile">
      <div className="profile-heading"><h2>Account</h2><p>Your trusted account information.</p></div>
      <dl className="profile-details">
        <div><dt>Name</dt><dd>{profile.displayName}</dd></div>
        <div><dt>Email</dt><dd>{profile.email}</dd></div>
        <div><dt>Role</dt><dd>{profile.systemRole === "ADMIN" ? "Administrator" : "Member"}</dd></div>
        <div><dt>Status</dt><dd>{profile.status === "ACTIVE" ? "Active" : profile.status}</dd></div>
        <div><dt>Sign-in</dt><dd>{profile.googleConnected ? "Google" : "—"}</dd></div>
      </dl>
      <button type="button" className="button" onClick={onSignOut}>Sign out</button>
    </section>
  </>;
}

function SignIn() {
  return (
    <main className="sign-in">
      <section>
        <Icon name="drive" size={30} />
        <h1>Docs Hub</h1>
        <p>Sign in to access your documents.</p>
        <a className="button button-primary" href={api.googleAuthUrl()}>
          Continue with Google
        </a>
      </section>
    </main>
  );
}

function SearchInput({ query }: { query: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(query);

  function submit(event: FormEvent) {
    event.preventDefault();
    navigateSearch(value.trim());
  }

  function clearOrBlur() {
    if (value) {
      setValue("");
      navigateSearch("");
    } else {
      input.current?.blur();
    }
  }

  return (
    <form className="shell-search" role="search" onSubmit={submit}>
      <Icon name="search" size={17} />
      <label className="visually-hidden" htmlFor="drive-search">
        Search files
      </label>
      <input
        id="drive-search"
        ref={input}
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            clearOrBlur();
          }
        }}
        placeholder="Search files"
        maxLength={200}
      />
    </form>
  );
}

function PageHeader({
  title,
  searchQuery,
  children,
}: {
  title: ReactNode;
  searchQuery?: string;
  children?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="page-context">{title}</div>
      {searchQuery !== undefined && <SearchInput query={searchQuery} />}
      <div className="toolbar-actions">{children}</div>
    </header>
  );
}

type SidebarRoute = "drive" | "recent" | "favorites" | "trash" | "admin" | null;

function AppShell({
  active,
  profile,
  onSignOut,
  children,
}: {
  active: SidebarRoute;
  profile: CurrentUser;
  onSignOut: () => void;
  children: ReactNode;
}) {
  return <div className="app-shell">
    <Sidebar active={active} profile={profile} onSignOut={onSignOut} />
    <main className="drive-main"><div className="page-scroll">{children}</div></main>
  </div>;
}

function Sidebar({ active, profile, onSignOut }: { active: SidebarRoute; profile: CurrentUser; onSignOut: () => void }) {
  const canAdmin = profile.status === "ACTIVE" && profile.systemRole === "ADMIN";
  return (
    <aside className="sidebar">
      <div className="brand">
        <Icon name="drive" size={22} />
        <span>Docs Hub</span>
      </div>
      <nav aria-label="Main navigation">
        <button
          className={`nav-item${active === "drive" ? " is-active" : ""}`}
          type="button"
          onClick={() => navigate(null)}
        >
          <Icon name="folder" />
          <span>Files</span>
        </button>
        <button
          className={`nav-item${active === "recent" ? " is-active" : ""}`}
          type="button"
          onClick={() => navigateCollection("recent")}
        >
          <Icon name="recent" />
          <span>Recent</span>
        </button>
        <button
          className={`nav-item${active === "favorites" ? " is-active" : ""}`}
          type="button"
          onClick={() => navigateCollection("favorites")}
        >
          <Icon name="star" />
          <span>Favorites</span>
        </button>
        <button
          className={`nav-item${active === "trash" ? " is-active" : ""}`}
          type="button"
          onClick={navigateTrash}
        >
          <Icon name="trash" />
          <span>Trash</span>
        </button>
        {canAdmin && <>
          <div className="sidebar-divider" />
          <button className={`nav-item${active === "admin" ? " is-active" : ""}`} type="button" onClick={() => navigateAdmin()}><Icon name="settings" /><span>Admin</span></button>
        </>}
      </nav>
      <AccountMenu profile={profile} onSignOut={onSignOut} />
    </aside>
  );
}

function AccountMenu({ profile, onSignOut }: { profile: CurrentUser; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const canAdmin = profile.status === "ACTIVE" && profile.systemRole === "ADMIN";
  const initials = profile.displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "U";
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const triggerElement = trigger.current;
      const menuElement = menu.current;
      if (!triggerElement || !menuElement) return;

      const triggerRect = triggerElement.getBoundingClientRect();
      const menuRect = menuElement.getBoundingClientRect();
      const margin = 12;
      const gap = 8;
      const maxLeft = Math.max(margin, window.innerWidth - margin - menuRect.width);
      const maxTop = Math.max(margin, window.innerHeight - margin - menuRect.height);

      const preferredRight = triggerRect.right + gap;
      const fallbackLeft = triggerRect.left - menuRect.width - gap;
      const preferredLeft =
        preferredRight + menuRect.width <= window.innerWidth - margin
          ? preferredRight
          : fallbackLeft;
      const left = Math.min(maxLeft, Math.max(margin, preferredLeft));

      const preferredAbove = triggerRect.top - menuRect.height - gap;
      const preferredBelow = triggerRect.bottom + gap;
      const preferredTop = preferredAbove >= margin ? preferredAbove : preferredBelow;
      const top = Math.min(maxTop, Math.max(margin, preferredTop));

      setPosition({ top, left });
    };

    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") setOpen(false);
      if (
        event instanceof MouseEvent &&
        !menu.current?.contains(event.target as globalThis.Node) &&
        !trigger.current?.contains(event.target as globalThis.Node)
      ) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  function go(action: () => void) {
    setOpen(false);
    action();
  }
  return <div className="account-area">
    <button
      ref={trigger}
      type="button"
      className="account-trigger"
      aria-expanded={open}
      aria-haspopup="menu"
      onClick={() => {
        setPosition(null);
        setOpen((value) => !value);
      }}
    >
      <span className="account-initials" aria-hidden="true">{initials}</span>
      <span className="account-copy"><strong>My account</strong><small>{profile.displayName}</small></span>
      <Icon name="chevron-down" size={15} />
    </button>
    {open && createPortal(
      <div
        ref={menu}
        className="account-menu"
        role="menu"
        style={{
          top: position?.top ?? 0,
          left: position?.left ?? 0,
          visibility: position ? "visible" : "hidden",
        }}
      >
        <div className="account-menu-profile"><strong>{profile.displayName}</strong><span>{profile.email}</span><small>{profile.systemRole === "ADMIN" ? "Administrator" : "Member"}</small></div>
        <div className="account-menu-divider" />
        <button type="button" role="menuitem" onClick={() => go(navigateProfile)}>Profile</button>
        {canAdmin && <button type="button" role="menuitem" onClick={() => go(() => navigateAdmin())}>Admin</button>}
        <div className="account-menu-divider" />
        <button type="button" role="menuitem" onClick={() => go(onSignOut)}>Sign out</button>
      </div>,
      document.body,
    )}
  </div>;
}

function DriveApp({ systemRole }: { systemRole: SystemRole }) {
  const [folderId, setFolderId] = useState(currentFolderId);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameNode, setRenameNode] = useState<Node | null>(null);
  const [editor, setEditor] = useState<EditorSession | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [shareNode, setShareNode] = useState<Node | null>(null);
  const [trashNode, setTrashNode] = useState<Node | null>(null);
  const [versionNode, setVersionNode] = useState<Node | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const uploadInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async (id: string | null) => {
    setStatus("loading");
    setError("");
    try {
      const [page, trail] = await Promise.all([
        api.listNodes(id),
        id ? api.breadcrumb(id) : Promise.resolve([]),
      ]);
      setNodes(page.items);
      setBreadcrumbs(trail);
      setStatus("ready");
    } catch (requestError) {
      setStatus("error");
      setError(displayError(requestError));
    }
  }, []);
  useEffect(() => {
    const onPopState = () => setFolderId(currentFolderId());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(folderId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [folderId, load]);
  useEffect(() => {
    let active = true;
    void api.listFavorites().then(
      (page) => active && setFavoriteIds(new Set(page.items.map((item) => item.id))),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);
  async function createFolder(name: string) {
    const node = await api.createFolder(name, folderId);
    setNodes((items) => [...items, node].sort(compareNodes));
    setNotice({ tone: "success", message: `Created “${node.name}”.` });
  }
  async function rename(node: Node, name: string) {
    const updated = await api.renameNode(node.id, name);
    setNodes((items) =>
      items
        .map((item) => (item.id === node.id ? updated : item))
        .sort(compareNodes),
    );
    setNotice({ tone: "success", message: "Name updated." });
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      setNotice(null);
      const result = await api.upload(file, folderId);
      setNodes((items) => [...items, result.node].sort(compareNodes));
      setNotice({
        tone: "success",
        message: `Uploaded “${result.node.name}”.`,
      });
    } catch (requestError) {
      setNotice({ tone: "error", message: displayError(requestError) });
    }
  }
  async function openFile(node: Node) {
    await openFileActivation(node, setEditor, setPreview, setNotice);
  }
  async function editFile(node: Node) {
    await openEditorForEdit(node, setEditor, setNotice);
  }
  function handleEditorSessionClosed() {
    void load(folderId);
  }
  function handleEditorSessionCloseError(requestError: unknown) {
    setNotice({ tone: "error", message: displayError(requestError) });
  }
  async function moveToTrash(node: Node) {
    await api.moveToTrash(node.id);
    setNodes((items) => items.filter((item) => item.id !== node.id));
    setNotice({ tone: "success", message: `Moved “${node.name}” to Trash.` });
  }
  async function toggleFavorite(node: Node) {
    const isFavorite = favoriteIds.has(node.id);
    try {
      await (isFavorite ? api.removeFavorite(node.id) : api.addFavorite(node.id));
      setFavoriteIds((current) => {
        const next = new Set(current);
        if (isFavorite) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
      setNotice({
        tone: "success",
        message: isFavorite ? "Removed from favorites." : "Added to favorites.",
      });
    } catch (requestError) {
      setNotice({ tone: "error", message: displayError(requestError) });
    }
  }
  const canPlaceAtRoot = systemRole === "ADMIN";
  const canCreateHere = folderId !== null || canPlaceAtRoot;
  return (
    <>
        <PageHeader title={<Breadcrumbs items={breadcrumbs} folderId={folderId} />} searchQuery="">
            <button
              type="button"
              className="icon-button"
              onClick={() => void load(folderId)}
              aria-label="Refresh folder"
            >
              <Icon name="refresh" />
            </button>
            {canCreateHere ? (
              <>
                <button
                  type="button"
                  className="button"
                  onClick={() => setCreateOpen(true)}
                >
                  <Icon name="plus" />
                  New folder
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => uploadInput.current?.click()}
                >
                  <Icon name="upload" />
                  Upload
                </button>
                <input
                  className="visually-hidden"
                  ref={uploadInput}
                  type="file"
                  onChange={upload}
                />
              </>
            ) : (
              <span className="root-permission-note">
                Root creation requires an administrator.
              </span>
            )}
        </PageHeader>
        <Toast notice={notice} onDismiss={() => setNotice(null)} />
        <section className="drive-content" aria-label="Files">
          {status === "loading" && <LoadingRows />}
          {status === "error" && (
            <ErrorState message={error} onRetry={() => void load(folderId)} />
          )}
          {status === "ready" && nodes.length === 0 && (
            <EmptyState
              canCreateHere={canCreateHere}
              onFolder={() => setCreateOpen(true)}
              onUpload={() => uploadInput.current?.click()}
            />
          )}
          {status === "ready" && nodes.length > 0 && (
            <FileList
              nodes={nodes}
              onFolder={(id) => navigate(id)}
              onRename={setRenameNode}
              onShare={setShareNode}
              onTrash={setTrashNode}
              onVersions={setVersionNode}
              onOpen={openFile}
              onEdit={editFile}
              onNotice={setNotice}
              favoriteIds={favoriteIds}
              onFavorite={toggleFavorite}
            />
          )}
        </section>
      {createOpen && (
        <NameDialog
          title="New folder"
          action="Create"
          onClose={() => setCreateOpen(false)}
          onSubmit={createFolder}
        />
      )}
      {renameNode && (
        <NameDialog
          title="Rename"
          action="Save"
          initialValue={renameNode.name}
          onClose={() => setRenameNode(null)}
          onSubmit={(name) => rename(renameNode, name)}
        />
      )}
      {shareNode && (
        <ShareDialog
          node={shareNode}
          onClose={() => setShareNode(null)}
          onNotice={setNotice}
        />
      )}
      {trashNode && (
        <ConfirmDialog
          title="Move to Trash"
          message={`Move “${trashNode.name}” to Trash?`}
          action="Move to Trash"
          onClose={() => setTrashNode(null)}
          onConfirm={() => moveToTrash(trashNode)}
          onNotice={setNotice}
        />
      )}
      {versionNode && (
        <VersionDialog
          node={versionNode}
          onClose={() => setVersionNode(null)}
          onNotice={setNotice}
        />
      )}
      {editor && (
        <EditorDialog
          session={editor}
          onClose={() => setEditor(null)}
          onSessionClosed={handleEditorSessionClosed}
          onSessionCloseError={handleEditorSessionCloseError}
        />
      )}
      {preview && (
        <PreviewDialog
          key={previewIsUnavailable(preview) ? `unavailable-${preview.nodeId}` : preview.sessionId}
          preview={preview}
          onClose={() => setPreview(null)}
          onDownload={() => api.downloadNode(preview.nodeId, preview.filename)}
        />
      )}
    </>
  );
}

function Breadcrumbs({
  items,
  folderId,
}: {
  items: Breadcrumb[];
  folderId: string | null;
}) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <button type="button" onClick={() => navigate(null)}>
        Files
      </button>
      {items.map((item, index) => (
        <span key={item.id} className="crumb">
          <Icon name="chevron" size={15} />
          {index === items.length - 1 && folderId === item.id ? (
            <span aria-current="page">{item.name}</span>
          ) : (
            <button type="button" onClick={() => navigate(item.id)}>
              {item.name}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}
function FileList({
  nodes,
  onFolder,
  onRename,
  onShare,
  onTrash,
  onVersions,
  onOpen,
  onEdit,
  onNotice,
  favoriteIds,
  onFavorite,
  dateLabel = "Modified",
}: {
  nodes: Node[];
  onFolder: (id: string) => void;
  onRename: (node: Node) => void;
  onShare: (node: Node) => void;
  onTrash: (node: Node) => void;
  onVersions: (node: Node) => void;
  onOpen: (node: Node) => void;
  onEdit: (node: Node) => void;
  onNotice: (notice: Notice) => void;
  favoriteIds: ReadonlySet<string>;
  onFavorite: (node: Node) => void;
  dateLabel?: string;
}) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  return (
    <div className="file-table-wrap">
      <table className="file-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">{dateLabel}</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <FileRow
              key={node.id}
              node={node}
              menuOpen={openMenuId === node.id}
              onToggleMenu={() =>
                setOpenMenuId((open) => (open === node.id ? null : node.id))
              }
              onCloseMenu={() => setOpenMenuId(null)}
              onFolder={onFolder}
              onRename={onRename}
              onShare={onShare}
              onTrash={onTrash}
              onVersions={onVersions}
              onOpen={onOpen}
              onEdit={onEdit}
              onNotice={onNotice}
              isFavorite={favoriteIds.has(node.id)}
              onFavorite={onFavorite}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
function FileRow({
  node,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onFolder,
  onRename,
  onShare,
  onTrash,
  onVersions,
  onOpen,
  onEdit,
  onNotice,
  isFavorite,
  onFavorite,
}: {
  node: Node;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onFolder: (id: string) => void;
  onRename: (node: Node) => void;
  onShare: (node: Node) => void;
  onTrash: (node: Node) => void;
  onVersions: (node: Node) => void;
  onOpen: (node: Node) => void;
  onEdit: (node: Node) => void;
  onNotice: (notice: Notice) => void;
  isFavorite: boolean;
  onFavorite: (node: Node) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const isFolder = node.type === "FOLDER";
  const canOpen =
    isFolder ||
    hasCapability(node, "PREVIEW") ||
    hasCapability(node, "DOWNLOAD");
  const canEdit =
    !isFolder &&
    isOnlyOfficeEditableFile(node.name) &&
    hasCapability(node, "EDIT");
  async function download() {
    try {
      await api.download(node);
    } catch (error) {
      onNotice({ tone: "error", message: displayError(error) });
    }
  }
  return (
    <tr>
      <td>
        <button
          className="file-name"
          type="button"
          onClick={() => (isFolder ? onFolder(node.id) : void onOpen(node))}
          disabled={!canOpen}
        >
          <Icon name={isFolder ? "folder" : "file"} size={19} />
          <span>{node.name}</span>
        </button>
      </td>
      <td className="modified">{formatDate(node.updatedAt)}</td>
      <td className="row-actions">
        <button
          ref={trigger}
          type="button"
          className="icon-button"
          aria-label={`Actions for ${node.name}`}
          aria-haspopup="menu"
          aria-controls={menuOpen ? `file-menu-${node.id}` : undefined}
          aria-expanded={menuOpen}
          onClick={onToggleMenu}
        >
          <Icon name="more" />
        </button>
        {menuOpen && (
          <RowMenu id={`file-menu-${node.id}`} trigger={trigger} onClose={onCloseMenu}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onCloseMenu();
                onFavorite(node);
              }}
            >
              <Icon name="star" size={16} />
              {isFavorite ? "Remove from favorites" : "Add to favorites"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onCloseMenu();
                if (isFolder) onFolder(node.id);
                else void onOpen(node);
              }}
              disabled={!canOpen}
            >
              {isFolder
                ? "Open folder"
                : isOnlyOfficeEditableFile(node.name) && hasCapability(node, "PREVIEW")
                  ? "Open"
                  : hasCapability(node, "PREVIEW")
                    ? "Preview"
                    : "Download"}
            </button>
            {canEdit && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onCloseMenu();
                  void onEdit(node);
                }}
              >
                <Icon name="edit" size={16} />
                Edit
              </button>
            )}
            {!isFolder && hasCapability(node, "DOWNLOAD") && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onCloseMenu();
                  void download();
                }}
              >
                <Icon name="download" size={16} />
                Download
              </button>
            )}
            {hasCapability(node, "RENAME") && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onCloseMenu();
                  onRename(node);
                }}
              >
                <Icon name="edit" size={16} />
                Rename
              </button>
            )}
            {!isFolder && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onCloseMenu();
                  onVersions(node);
                }}
              >
                Version history
              </button>
            )}
            {hasCapability(node, "SHARE") && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onCloseMenu();
                  onShare(node);
                }}
              >
                <Icon name="share" size={16} />
                Share
              </button>
            )}
            {hasCapability(node, "DELETE") && (
              <button
                type="button"
                role="menuitem"
                className="menu-danger"
                onClick={() => {
                  onCloseMenu();
                  onTrash(node);
                }}
              >
                <Icon name="trash" size={16} />
                Move to Trash
              </button>
            )}
          </RowMenu>
        )}
      </td>
    </tr>
  );
}
function RowMenu({
  id,
  trigger,
  onClose,
  children,
}: {
  id: string;
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: -9999, left: -9999 });
  function moveMenuFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (!items.length) return;
    event.preventDefault();
    if (event.key === "Home") {
      items[0].focus();
      return;
    }
    if (event.key === "End") {
      items[items.length - 1].focus();
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    items[(current + offset + items.length) % items.length].focus();
  }
  useLayoutEffect(() => {
    const place = () => {
      const anchor = trigger.current;
      const element = menu.current;
      if (!anchor || !element) return;
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const below = rect.bottom + gap;
      const top =
        below + height <= window.innerHeight - margin
          ? below
          : Math.max(margin, rect.top - gap - height);
      const left = Math.min(
        window.innerWidth - margin - width,
        Math.max(margin, rect.right - width),
      );
      setPosition({ top, left });
    };
    place();
    const closeForViewportChange = () => {
      onClose();
      trigger.current?.focus();
    };
    window.addEventListener("resize", closeForViewportChange);
    window.addEventListener("scroll", closeForViewportChange, true);
    return () => {
      window.removeEventListener("resize", closeForViewportChange);
      window.removeEventListener("scroll", closeForViewportChange, true);
    };
  }, [onClose, trigger]);
  useEffect(() => {
    const firstItem = menu.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    firstItem?.focus();
  }, []);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as globalThis.Node) &&
        !trigger.current?.contains(event.target as globalThis.Node)
      ) {
        onClose();
        trigger.current?.focus();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [onClose, trigger]);
  useEffect(() => {
    const menuElement = menu.current;
    const triggerElement = trigger.current;
    return () => {
      if (document.activeElement && menuElement?.contains(document.activeElement)) {
        triggerElement?.focus();
      }
    };
  }, [trigger]);
  return createPortal(
    <div
      id={id}
      ref={menu}
      className="row-menu"
      role="menu"
      style={position}
      onKeyDown={moveMenuFocus}
    >
      {children}
    </div>,
    document.body,
  );
}
function ShareDialog({
  node,
  onClose,
  onNotice,
}: {
  node: Node;
  onClose: () => void;
  onNotice: (notice: Notice) => void;
}) {
  const [sharing, setSharing] = useState<SharingState | null>(null);
  const [permissions, setPermissions] = useState<PermissionsState | null>(null);
  const [principalResults, setPrincipalResults] = useState<SharingPrincipal[]>([]);
  const [principalQuery, setPrincipalQuery] = useState("");
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [pending, setPending] = useState(false);
  const [principalType, setPrincipalType] = useState<"USER" | "GROUP">("USER");
  const [selectedPrincipal, setSelectedPrincipal] = useState<SharingPrincipal | null>(null);
  const [role, setRole] = useState<DocumentRole>("VIEWER");
  const [addOpen, setAddOpen] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const principalSearch = useRef<HTMLInputElement>(null);
  const dialog = useDialogFocus();

  const load = useCallback(async () => {
    setError("");
    try {
      const [sharingState, permissionState] = await Promise.all([
        api.sharing(node.id),
        api.permissions(node.id),
      ]);
      setSharing(sharingState);
      setPermissions(permissionState);
    } catch (requestError) {
      setError(displayError(requestError));
    }
  }, [node.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!addOpen) return;
    principalSearch.current?.focus();
  }, [addOpen]);

  useEffect(() => {
    if (!addOpen) return;
    const timer = window.setTimeout(() => {
      if (principalQuery.trim().length < 2) {
        setPrincipalResults([]);
        setLookupError("");
        return;
      }
      setLookupError("");
      void api.findPrincipals(principalQuery).then(
        (response) => setPrincipalResults(response.items),
        () => {
          setPrincipalResults([]);
          setLookupError("Directory search is unavailable.");
        },
      );
    }, 180);
    return () => window.clearTimeout(timer);
  }, [addOpen, principalQuery]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (addOpen) {
        event.preventDefault();
        setAddOpen(false);
        setPrincipalQuery("");
        setPrincipalResults([]);
        setSelectedPrincipal(null);
        window.setTimeout(() => addButton.current?.focus(), 0);
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [addOpen, onClose]);

  function closeAddForm() {
    setAddOpen(false);
    setPrincipalQuery("");
    setPrincipalResults([]);
    setSelectedPrincipal(null);
    setLookupError("");
    window.setTimeout(() => addButton.current?.focus(), 0);
  }

  async function mutate(
    action: () => Promise<unknown>,
    success: string,
    afterSuccess?: () => void,
  ) {
    setPending(true);
    setError("");
    try {
      await action();
      await load();
      afterSuccess?.();
      onNotice({ tone: "success", message: success });
    } catch (requestError) {
      onNotice({ tone: "error", message: displayError(requestError) });
    } finally {
      setPending(false);
    }
  }

  async function copyLink() {
    if (!linkUrl) return;
    try {
      await navigator.clipboard.writeText(linkUrl);
      onNotice({ tone: "success", message: "Link copied." });
    } catch {
      onNotice({ tone: "error", message: "Could not copy the link." });
    }
  }

  const principals = principalResults.filter((principal) => principal.type === principalType);
  const selectedName = selectedPrincipal
    ? selectedPrincipal.type === "USER"
      ? selectedPrincipal.displayName ?? "User"
      : selectedPrincipal.name ?? "Group"
    : "";

  async function addPermission() {
    if (!selectedPrincipal) return;
    await mutate(
      () => selectedPrincipal.type === "USER"
        ? api.setUserPermission(node.id, selectedPrincipal.id, role)
        : api.setGroupPermission(node.id, selectedPrincipal.id, role),
      "Permission added.",
      closeAddForm,
    );
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialog} className="dialog share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
        <header className="dialog-header">
          <div><h2 id="share-dialog-title">Share “{node.name}”</h2></div>
          <button type="button" className="icon-button" aria-label="Close sharing" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        {error && <p className="form-error" role="alert">{error}</p>}
        {!sharing || !permissions ? (
          <p className="dialog-loading">Loading sharing settings…</p>
        ) : (
          <div className="share-body">
            <section className="share-section">
              <h3>People with access</h3>
              <div className="permission-list">
                {permissions.entries.map((entry) => (
                  <PermissionRow
                    key={entry.id}
                    entry={entry}
                    disabled={pending}
                    onRole={(nextRole) => void mutate(
                      () => entry.principalType === "USER"
                        ? api.setUserPermission(node.id, entry.principal.id, nextRole)
                        : api.setGroupPermission(node.id, entry.principal.id, nextRole),
                      "Permission updated.",
                    )}
                    onRemove={() => void mutate(
                      () => api.removePermission(node.id, entry),
                      "Permission removed.",
                    )}
                  />
                ))}
                {permissions.entries.length === 0 && <p className="muted-copy">No direct permissions.</p>}
              </div>
              <button
                ref={addButton}
                type="button"
                className="button add-people-button"
                aria-expanded={addOpen}
                onClick={() => {
                  if (addOpen) closeAddForm();
                  else {
                    setAddOpen(true);
                    setPrincipalQuery("");
                    setPrincipalResults([]);
                    setSelectedPrincipal(null);
                  }
                }}
              >
                {addOpen ? "Close" : "Add people or groups"}
              </button>
              {addOpen && (
                <div className="permission-add" aria-label="Add a person or group">
                  <div className="principal-search-row">
                    <select
                      aria-label="Search type"
                      value={principalType}
                      onChange={(event) => {
                        setPrincipalType(event.target.value as "USER" | "GROUP");
                        setSelectedPrincipal(null);
                      }}
                      disabled={pending}
                    >
                      <option value="USER">People</option>
                      <option value="GROUP">Groups</option>
                    </select>
                    <input
                      ref={principalSearch}
                      aria-label={`Search ${principalType === "USER" ? "people" : "groups"}`}
                      value={principalQuery}
                      onChange={(event) => {
                        setPrincipalQuery(event.target.value);
                        setSelectedPrincipal(null);
                      }}
                      placeholder={`Search ${principalType === "USER" ? "people" : "groups"}`}
                      disabled={pending}
                    />
                  </div>
                  {lookupError && <p className="form-error" role="alert">{lookupError}</p>}
                  {principalQuery.trim().length < 2 ? (
                    <p className="muted-copy search-hint">Type at least 2 characters to search.</p>
                  ) : principals.length > 0 ? (
                    <div className="principal-results" aria-label="Search results">
                      {principals.map((principal) => {
                        const name = principal.type === "USER" ? principal.displayName ?? "User" : principal.name ?? "Group";
                        const secondary = principal.type === "USER" ? principal.email ?? "Person" : "Group";
                        const selected = selectedPrincipal?.id === principal.id;
                        return (
                          <button
                            key={principal.id}
                            type="button"
                            className="principal-result"
                            aria-pressed={selected}
                            onClick={() => setSelectedPrincipal(principal)}
                          >
                            <span><strong>{name}</strong><small>{secondary}</small></span>
                            {selected && <span className="selected-label">Selected</span>}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="muted-copy search-hint">No matching {principalType === "USER" ? "people" : "groups"}.</p>
                  )}
                  {selectedPrincipal && (
                    <div className="selected-principal">
                      <span>Sharing with <strong>{selectedName}</strong></span>
                      <label>
                        <span className="visually-hidden">Role for {selectedName}</span>
                        <select aria-label={`Role for ${selectedName}`} value={role} onChange={(event) => setRole(event.target.value as DocumentRole)} disabled={pending}>
                          <option value="VIEWER">Viewer</option>
                          <option value="EDITOR">Editor</option>
                          <option value="OWNER">Owner</option>
                        </select>
                      </label>
                      <button type="button" className="button button-primary" disabled={pending} onClick={() => void addPermission()}>
                        {pending ? "Adding…" : "Add"}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="share-section">
              <h3>General access</h3>
              <label className="access-setting">
                <span>
                  <strong>{sharing.publicAccess ? "Anyone with the link" : "Restricted"}</strong>
                  <small>{sharing.publicAccess ? "Anyone with the link can view." : "Only people with access can view."}</small>
                </span>
                <span className="access-toggle">
                  <span>Anyone with the link</span>
                  <input
                    type="checkbox"
                    aria-label="Anyone with the link can view"
                    checked={sharing.publicAccess}
                    disabled={pending}
                    onChange={(event) => void mutate(
                      () => api.setPublicAccess(node.id, event.target.checked),
                      "General access updated.",
                    )}
                  />
                </span>
              </label>
              <div className="issued-link-row">
                <div className="issued-link-state">
                  <strong>Share link</strong>
                  <small>{!sharing.shareLink.exists ? "No link created" : linkUrl ? "Link ready to copy" : "Active link. Reset to issue a new URL."}</small>
                </div>
                {!sharing.shareLink.exists ? (
                  <button type="button" className="button" disabled={pending} onClick={() => void mutate(async () => {
                    const result = await api.createShareLink(node.id);
                    setLinkUrl(result.shareLink.url);
                  }, "Link created.")}>Create link</button>
                ) : linkUrl ? (
                  <div className="share-link">
                    <input readOnly value={linkUrl} aria-label="Issued share link" />
                    <button type="button" className="button" onClick={() => void copyLink()}>Copy</button>
                  </div>
                ) : null}
              </div>
              {sharing.shareLink.exists && (
                <details className="link-options">
                  <summary>Link options</summary>
                  <div className="link-option-actions">
                    <button type="button" className="text-button secondary-action" disabled={pending} onClick={() => void mutate(async () => {
                      const result = await api.resetShareLink(node.id);
                      setLinkUrl(result.shareLink.url);
                    }, "Link reset.")}>Reset link</button>
                    <button type="button" className="text-button secondary-action" disabled={pending} onClick={() => void mutate(async () => {
                      await api.revokeShareLink(node.id);
                      setLinkUrl(null);
                    }, "Link revoked.")}>Revoke link</button>
                  </div>
                </details>
              )}
            </section>

            <details className="advanced-access">
              <summary>Advanced access</summary>
              <label className="inherit-setting">
                <input
                  type="checkbox"
                  checked={permissions.inheritPermissions}
                  disabled={pending}
                  onChange={(event) => {
                    const value = event.target.checked;
                    if (!value && !window.confirm("Stop inheriting access from the parent folder?")) return;
                    void mutate(() => api.setInheritance(node.id, value), "Inheritance updated.");
                  }}
                />
                <span>Inherit permissions from parent</span>
              </label>
            </details>
          </div>
        )}
        <footer className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}
function PermissionRow({
  entry,
  disabled,
  onRole,
  onRemove,
}: {
  entry: PermissionEntry;
  disabled: boolean;
  onRole: (role: DocumentRole) => void;
  onRemove: () => void;
}) {
  const label =
    entry.principalType === "USER"
      ? `${entry.principal.displayName ?? "User"}${entry.principal.email ? ` — ${entry.principal.email}` : ""}`
      : (entry.principal.name ?? "Group");
  return (
    <div className="permission-row">
      <div>
        <strong>{label}</strong>
        <small>
          {entry.principalType === "USER"
            ? "Direct user permission"
            : "Direct group permission"}
        </small>
      </div>
      <select
        aria-label={`Role for ${label}`}
        value={entry.role}
        disabled={disabled}
        onChange={(event) => onRole(event.target.value as DocumentRole)}
      >
        <option value="VIEWER">Viewer</option>
        <option value="EDITOR">Editor</option>
        <option value="OWNER">Owner</option>
      </select>
      <button
        type="button"
        className="text-button text-button-danger"
        disabled={disabled}
        onClick={onRemove}
      >
        Remove
      </button>
    </div>
  );
}

type SearchLocation = {
  items: Breadcrumb[];
  truncated: boolean;
};

function CollectionApp({ kind }: { kind: "recent" | "favorites" }) {
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [editor, setEditor] = useState<EditorSession | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [renameNode, setRenameNode] = useState<Node | null>(null);
  const [shareNode, setShareNode] = useState<Node | null>(null);
  const [trashNode, setTrashNode] = useState<Node | null>(null);
  const [versionNode, setVersionNode] = useState<Node | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      const [page, favorites] = await Promise.all([
        kind === "recent" ? api.listRecent() : api.listFavorites(),
        kind === "recent" ? api.listFavorites() : Promise.resolve(null),
      ]);
      setItems(page.items);
      setFavoriteIds(new Set((favorites?.items ?? page.items).map((item) => item.id)));
      setStatus("ready");
    } catch (requestError) {
      setError(displayError(requestError));
      setStatus("error");
    }
  }, [kind]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function openFile(node: Node) {
    await openFileActivation(node, setEditor, setPreview, setNotice);
  }
  async function editFile(node: Node) {
    await openEditorForEdit(node, setEditor, setNotice);
  }
  function handleEditorSessionClosed() {
    void load();
  }
  function handleEditorSessionCloseError(requestError: unknown) {
    setNotice({ tone: "error", message: displayError(requestError) });
  }

  async function rename(node: Node, name: string) {
    const updated = await api.renameNode(node.id, name);
    setItems((current) => current.map((item) => item.id === node.id ? { ...item, ...updated } : item));
    setNotice({ tone: "success", message: "Name updated." });
  }

  async function moveToTrash(node: Node) {
    await api.moveToTrash(node.id);
    setItems((current) => current.filter((item) => item.id !== node.id));
    setFavoriteIds((current) => {
      const next = new Set(current);
      next.delete(node.id);
      return next;
    });
    setNotice({ tone: "success", message: `Moved “${node.name}” to Trash.` });
  }

  async function toggleFavorite(node: Node) {
    const isFavorite = favoriteIds.has(node.id);
    try {
      await (isFavorite ? api.removeFavorite(node.id) : api.addFavorite(node.id));
      setFavoriteIds((current) => {
        const next = new Set(current);
        if (isFavorite) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
      if (isFavorite && kind === "favorites")
        setItems((current) => current.filter((item) => item.id !== node.id));
      setNotice({ tone: "success", message: isFavorite ? "Removed from favorites." : "Added to favorites." });
    } catch (requestError) {
      setNotice({ tone: "error", message: displayError(requestError) });
    }
  }

  const displayItems: Node[] = items.map((item) => ({
    ...item,
    updatedAt: kind === "recent" ? item.lastAccessedAt ?? item.updatedAt : item.favoritedAt ?? item.updatedAt,
  }));
  const title = kind === "recent" ? "Recent" : "Favorites";
  const emptyTitle = kind === "recent" ? "No recent files yet" : "No favorites yet";
  return (
    <>
        <PageHeader title={<h1 className="page-title">{title}</h1>}>
          <button type="button" className="icon-button" onClick={() => void load()} aria-label={`Refresh ${title}`}>
            <Icon name="refresh" />
          </button>
        </PageHeader>
        <section className="drive-content" aria-label={title}>
          {status === "loading" && <LoadingRows label={`Loading ${title.toLowerCase()}`} />}
          {status === "error" && <CollectionError title={title} message={error} onRetry={() => void load()} />}
          {status === "ready" && displayItems.length === 0 && <SearchState title={emptyTitle} />}
          {status === "ready" && displayItems.length > 0 && <FileList nodes={displayItems} onFolder={(id) => navigate(id)} onRename={setRenameNode} onShare={setShareNode} onTrash={setTrashNode} onVersions={setVersionNode} onOpen={openFile} onEdit={editFile} onNotice={setNotice} favoriteIds={favoriteIds} onFavorite={toggleFavorite} dateLabel={kind === "recent" ? "Last opened" : "Added"} />}
        </section>
      <Toast notice={notice} onDismiss={() => setNotice(null)} />
      {renameNode && <NameDialog title="Rename" action="Save" initialValue={renameNode.name} onClose={() => setRenameNode(null)} onSubmit={(name) => rename(renameNode, name)} />}
      {shareNode && <ShareDialog node={shareNode} onClose={() => setShareNode(null)} onNotice={setNotice} />}
      {trashNode && <ConfirmDialog title="Move to Trash" message={`Move “${trashNode.name}” to Trash?`} action="Move to Trash" onClose={() => setTrashNode(null)} onConfirm={() => moveToTrash(trashNode)} onNotice={setNotice} />}
      {versionNode && <VersionDialog node={versionNode} onClose={() => setVersionNode(null)} onNotice={setNotice} />}
      {editor && <EditorDialog session={editor} onClose={() => setEditor(null)} onSessionClosed={handleEditorSessionClosed} onSessionCloseError={handleEditorSessionCloseError} />}
      {preview && (
        <PreviewDialog
          key={previewIsUnavailable(preview) ? `unavailable-${preview.nodeId}` : preview.sessionId}
          preview={preview}
          onClose={() => setPreview(null)}
          onDownload={() => api.downloadNode(preview.nodeId, preview.filename)}
        />
      )}
    </>
  );
}

function CollectionError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return <div className="content-state"><h1>Couldn’t load {title.toLowerCase()}.</h1><p>{message}</p><button type="button" className="button" onClick={onRetry}>Retry</button></div>;
}

function SearchApp({ query }: { query: string }) {
  const normalizedQuery = query.trim();
  const [items, setItems] = useState<SearchItem[]>([]);
  const [locations, setLocations] = useState<Record<string, SearchLocation | null>>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error" | "invalid">("idle");
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [editor, setEditor] = useState<EditorSession | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const requestId = useRef(0);

  const loadLocations = useCallback(
    async (searchItems: SearchItem[], activeRequest: number, signal: AbortSignal) => {
      const resolved = await Promise.all(
        searchItems.map(async (item) => {
          try {
            return [item.id, await api.breadcrumbPage(item.id, signal)] as const;
          } catch {
            return [item.id, null] as const;
          }
        }),
      );
      if (requestId.current !== activeRequest || signal.aborted) return;
      setLocations((current) => {
        const next = { ...current };
        for (const location of resolved) next[location[0]] = location[1];
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    const activeRequest = ++requestId.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setItems([]);
      setLocations({});
      setNextCursor(null);
      setLoadingMore(false);
      setError("");
      if (!normalizedQuery) {
        setStatus("idle");
        return;
      }
      if (normalizedQuery.length > 200) {
        setStatus("invalid");
        return;
      }
      setStatus("loading");
      void api.search(normalizedQuery, undefined, controller.signal).then(
        (page) => {
          if (requestId.current !== activeRequest || controller.signal.aborted) return;
          setItems(page.items);
          setNextCursor(page.nextCursor);
          setStatus("ready");
          void loadLocations(page.items, activeRequest, controller.signal);
        },
        (requestError: unknown) => {
          if (requestId.current !== activeRequest || controller.signal.aborted) return;
          setError(displayError(requestError));
          setStatus("error");
        },
      );
    }, 0);
    return () => {
      if (requestId.current === activeRequest) requestId.current += 1;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadLocations, normalizedQuery]);

  async function retry() {
    navigateSearch(normalizedQuery);
    const activeRequest = requestId.current;
    const controller = new AbortController();
    setStatus("loading");
    setError("");
    try {
      const page = await api.search(normalizedQuery, undefined, controller.signal);
      if (requestId.current !== activeRequest) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setLocations({});
      setStatus("ready");
      void loadLocations(page.items, activeRequest, controller.signal);
    } catch (requestError) {
      if (requestId.current !== activeRequest) return;
      setError(displayError(requestError));
      setStatus("error");
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const activeRequest = requestId.current;
    const controller = new AbortController();
    setLoadingMore(true);
    try {
      const page = await api.search(normalizedQuery, nextCursor, controller.signal);
      if (requestId.current !== activeRequest) return;
      const newItems = page.items.filter(
        (item) => !items.some((current) => current.id === item.id),
      );
      setItems((current) => [...current, ...newItems]);
      setNextCursor(page.nextCursor);
      void loadLocations(newItems, activeRequest, controller.signal);
    } catch (requestError) {
      if (requestId.current !== activeRequest) return;
      setNotice({ tone: "error", message: displayError(requestError) });
    } finally {
      if (requestId.current === activeRequest) setLoadingMore(false);
    }
  }

  async function openItem(item: SearchItem) {
    if (item.type === "FOLDER") {
      navigate(item.id);
      return;
    }
    try {
      const node = await api.getNode(item.id);
      await openFileActivation(node, setEditor, setPreview, setNotice);
    } catch (requestError) {
      setNotice({ tone: "error", message: displayError(requestError) });
    }
  }

  return (
    <>
        <header className="topbar">
          <div className="page-context"><h1 className="page-title">Search</h1></div>
          <SearchInput key={query} query={query} />
          <div className="toolbar-actions" />
        </header>
        <section className="drive-content" aria-label="Search results">
          {status === "idle" && <SearchState title="Search files" message="Enter a file or folder name, or words from an indexed document." />}
          {status === "invalid" && <SearchState title="Search query is too long" message="Search queries can be up to 200 characters." />}
          {status === "loading" && <LoadingRows label="Loading search results" />}
          {status === "error" && <SearchError message={error} onRetry={() => void retry()} />}
          {status === "ready" && items.length === 0 && <SearchState title={`No files found for “${normalizedQuery}”`} />}
          {status === "ready" && items.length > 0 && (
            <>
              <SearchResultsTable items={items} locations={locations} onOpen={openItem} />
              {nextCursor && <div className="search-more"><button type="button" className="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more"}</button></div>}
            </>
          )}
        </section>
      <Toast notice={notice} onDismiss={() => setNotice(null)} />
      {editor && <EditorDialog session={editor} onClose={() => setEditor(null)} onSessionClosed={() => void retry()} onSessionCloseError={(requestError) => setNotice({ tone: "error", message: displayError(requestError) })} />}
      {preview && (
        <PreviewDialog
          key={previewIsUnavailable(preview) ? `unavailable-${preview.nodeId}` : preview.sessionId}
          preview={preview}
          onClose={() => setPreview(null)}
          onDownload={() => api.downloadNode(preview.nodeId, preview.filename)}
        />
      )}
    </>
  );
}

function searchLocationLabel(location: SearchLocation | null | undefined) {
  if (location === undefined) return "Loading location…";
  if (location === null) return "Location unavailable";
  const parents = location.items.slice(0, -1).map((item) => item.name);
  if (!parents.length) return location.truncated ? "Shared location" : "Files";
  return `${location.truncated ? "… / " : ""}${parents.join(" / ")}`;
}

function SearchResultsTable({
  items,
  locations,
  onOpen,
}: {
  items: SearchItem[];
  locations: Record<string, SearchLocation | null>;
  onOpen: (item: SearchItem) => void;
}) {
  return (
    <div className="file-table-wrap">
      <table className="file-table search-table">
        <thead><tr><th scope="col">Name</th><th scope="col">Location</th><th scope="col">Type</th><th scope="col">Modified</th></tr></thead>
        <tbody>{items.map((item) => (
          <tr key={item.id}>
            <td><button type="button" className="file-name" onClick={() => void onOpen(item)}><Icon name={item.type === "FOLDER" ? "folder" : "file"} size={19} /><span>{item.name}</span></button></td>
            <td className="search-location" title={searchLocationLabel(locations[item.id])}>{searchLocationLabel(locations[item.id])}</td>
            <td className="search-type">{item.type === "FOLDER" ? "Folder" : "File"}</td>
            <td className="modified">{formatDate(item.updatedAt)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function SearchState({ title, message }: { title: string; message?: string }) {
  return <div className="content-state search-state"><h1>{title}</h1>{message && <p>{message}</p>}</div>;
}

function SearchError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="content-state search-state"><h1>Couldn’t search files.</h1><p>{message}</p><button type="button" className="button" onClick={onRetry}>Retry</button></div>;
}

function TrashApp() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ item: TrashItem; action: "restore" | "purge" } | null>(null);
  const load = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      const page = await api.listTrash();
      setItems(page.items);
      setStatus("ready");
    } catch (requestError) {
      setError(displayError(requestError));
      setStatus("error");
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  async function apply(item: TrashItem, action: "restore" | "purge") {
    if (action === "restore") await api.restoreTrash(item.trashOperationId);
    else await api.purgeTrash(item.trashOperationId);
    setItems((current) => current.filter((entry) => entry.trashOperationId !== item.trashOperationId));
    setNotice({
      tone: "success",
      message: action === "restore" ? `Restored “${item.name}”.` : `Permanently deleted “${item.name}”.`,
    });
  }
  return (
    <>
        <PageHeader title={<h1 className="page-title">Trash</h1>}>
          <button type="button" className="icon-button" onClick={() => void load()} aria-label="Refresh Trash">
            <Icon name="refresh" />
          </button>
        </PageHeader>
        <section className="drive-content" aria-label="Trash">
          {status === "loading" && <LoadingRows />}
          {status === "error" && <ErrorState message={error} onRetry={() => void load()} />}
          {status === "ready" && items.length === 0 && <div className="content-state"><h1>Trash is empty</h1></div>}
          {status === "ready" && items.length > 0 && (
            <div className="file-table-wrap"><table className="file-table trash-table">
              <colgroup><col /><col className="trash-date-column" /><col className="trash-expiry-column" /><col className="trash-menu-column" /></colgroup>
              <thead><tr><th scope="col">Name</th><th scope="col">Trashed</th><th scope="col">Auto-delete</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
              <tbody>{items.map((item) => (
                <TrashRow
                  key={item.trashOperationId}
                  item={item}
                  menuOpen={openMenuId === item.trashOperationId}
                  onToggleMenu={() => setOpenMenuId((open) => open === item.trashOperationId ? null : item.trashOperationId)}
                  onCloseMenu={() => setOpenMenuId(null)}
                  onConfirm={(action) => setConfirmation({ item, action })}
                />
              ))}</tbody>
            </table></div>
          )}
        </section>
      <Toast notice={notice} onDismiss={() => setNotice(null)} />
      {confirmation && (
        <ConfirmDialog
          title={confirmation.action === "restore" ? "Restore from Trash" : "Permanently delete"}
          message={confirmation.action === "restore" ? `Restore “${confirmation.item.name}” to its original location?` : `Permanently delete “${confirmation.item.name}”? This cannot be undone.`}
          action={confirmation.action === "restore" ? "Restore" : "Delete permanently"}
          onClose={() => setConfirmation(null)}
          onConfirm={() => apply(confirmation.item, confirmation.action)}
          onNotice={setNotice}
        />
      )}
    </>
  );
}
function TrashRow({
  item,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onConfirm,
}: {
  item: TrashItem;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onConfirm: (action: "restore" | "purge") => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <tr>
      <td className="trash-name">
        <span className="file-name"><Icon name={item.type === "FOLDER" ? "folder" : "file"} size={19} /><span>{item.name}</span></span>
      </td>
      <td className="modified">{formatDate(item.trashedAt)}</td>
      <td className="modified">{formatDate(item.expiresAt)}</td>
      <td className="row-actions">
        <button
          ref={trigger}
          type="button"
          className="icon-button"
          aria-label={`Actions for ${item.name}`}
          aria-haspopup="menu"
          aria-controls={menuOpen ? `trash-menu-${item.trashOperationId}` : undefined}
          aria-expanded={menuOpen}
          onClick={onToggleMenu}
        >
          <Icon name="more" />
        </button>
        {menuOpen && (
          <RowMenu id={`trash-menu-${item.trashOperationId}`} trigger={trigger} onClose={onCloseMenu}>
            {item.canRestore && <button type="button" role="menuitem" onClick={() => { onCloseMenu(); onConfirm("restore"); }}>Restore</button>}
            {item.canPurge && <button type="button" role="menuitem" className="menu-danger" onClick={() => { onCloseMenu(); onConfirm("purge"); }}>Delete permanently</button>}
          </RowMenu>
        )}
      </td>
    </tr>
  );
}
function VersionDialog({ node, onClose, onNotice }: { node: Node; onClose: () => void; onNotice: (notice: Notice) => void }) {
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const dialog = useDialogFocus();
  const load = useCallback(async () => {
    setError("");
    try {
      setVersions((await api.listVersions(node.id)).items);
    } catch (requestError) {
      setError(displayError(requestError));
    }
  }, [node.id]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  async function restore(version: FileVersion) {
    if (!window.confirm(`Create a new version from Version ${version.versionNumber}? The existing versions will remain unchanged.`)) return;
    setPending(version.id);
    setError("");
    try {
      await api.restoreVersion(node.id, version.id);
      await load();
      onNotice({ tone: "success", message: "Version restored." });
    } catch (requestError) {
      onNotice({ tone: "error", message: displayError(requestError) });
    } finally {
      setPending(null);
    }
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialog} className="dialog version-dialog" role="dialog" aria-modal="true" aria-labelledby="version-dialog-title">
        <header className="dialog-header">
          <div><h2 id="version-dialog-title">Version history</h2><p>{node.name}</p></div>
          <button type="button" className="icon-button" aria-label="Close version history" onClick={onClose}><Icon name="close" /></button>
        </header>
        {error && <p className="form-error" role="alert">{error}</p>}
        {!versions ? <p className="dialog-loading">Loading versions…</p> : (
          <div className="version-list">{versions.map((version) => (
            <div className="version-row" key={version.id}>
              <div className="version-title-row">
                <strong>Version {version.versionNumber}</strong>
                {version.isCurrent && <span className="version-current">Current</span>}
              </div>
              <div className="version-metadata">
                <span>{formatDate(version.createdAt)}</span>
                <span>{formatVersionSource(version.source)}</span>
                <span>{formatBytes(version.sizeBytes)}</span>
              </div>
              <div className="version-actions">
                {hasCapability(node, "DOWNLOAD") && <button type="button" className="version-action" disabled={pending !== null} onClick={() => void api.downloadVersion(node, version).catch((requestError) => onNotice({ tone: "error", message: displayError(requestError) }))}>Download</button>}
                {!version.isCurrent && hasCapability(node, "RESTORE_VERSION") && <button type="button" className="version-action" disabled={pending !== null} onClick={() => void restore(version)}>{pending === version.id ? "Restoring…" : "Restore"}</button>}
              </div>
            </div>
          ))}</div>
        )}
        <footer className="dialog-actions"><button type="button" className="button" onClick={onClose}>Done</button></footer>
      </section>
    </div>
  );
}
function ConfirmDialog({
  title,
  message,
  action,
  onClose,
  onConfirm,
  onNotice,
}: {
  title: string;
  message: string;
  action: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  onNotice: (notice: Notice) => void;
}) {
  const [pending, setPending] = useState(false);
  const dialog = useDialogFocus();
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose, pending]);
  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      onClose();
    } catch (requestError) {
      onNotice({ tone: "error", message: displayError(requestError) });
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialog}
        className="dialog confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <header className="dialog-header">
          <div><h2 id="confirm-dialog-title">{title}</h2></div>
          <button type="button" className="icon-button" aria-label={`Close ${title}`} disabled={pending} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog-body"><p>{message}</p></div>
        <footer className="dialog-actions">
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`button${action === "Restore" ? " button-primary" : " button-danger"}`}
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending ? `${action}…` : action}
          </button>
        </footer>
      </section>
    </div>
  );
}
function NameDialog({
  title,
  action,
  initialValue = "",
  onClose,
  onSubmit,
}: {
  title: string;
  action: string;
  initialValue?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const dialog = useDialogFocus();
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose, pending]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value) {
      setError("Enter a name.");
      return;
    }
    setPending(true);
    setError("");
    try {
      await onSubmit(value);
      onClose();
    } catch (requestError) {
      setError(displayError(requestError));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialog}
        className="dialog name-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="name-dialog-title"
      >
        <header className="dialog-header">
          <div><h2 id="name-dialog-title">{title}</h2></div>
          <button type="button" className="icon-button" aria-label={`Close ${title}`} disabled={pending} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <form onSubmit={submit}>
          <label htmlFor="node-name">Name</label>
          <input
            id="node-name"
            ref={input}
            data-dialog-initial-focus
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={255}
            disabled={pending}
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={pending}
            >
              {pending ? `${action}…` : action}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
function EmptyState({
  canCreateHere,
  onFolder,
  onUpload,
}: {
  canCreateHere: boolean;
  onFolder: () => void;
  onUpload: () => void;
}) {
  return (
    <div className="content-state">
      <h1>No files here</h1>
      {canCreateHere && (
        <div>
          <button type="button" className="button" onClick={onFolder}>
            New folder
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={onUpload}
          >
            Upload file
          </button>
        </div>
      )}
      {!canCreateHere && <p>Root creation requires an administrator.</p>}
    </div>
  );
}
function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="content-state">
      <h1>Couldn’t load this folder.</h1>
      <p>{message}</p>
      <button type="button" className="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
function LoadingRows({ label = "Loading files" }: { label?: string }) {
  return (
    <div className="loading-list" role="status">
      <span>{label}…</span>
    </div>
  );
}

const EDITOR_VIEWPORT_MARGIN = 24;
const EDITOR_MIN_WIDTH = 720;
const EDITOR_MIN_HEIGHT = 500;

type EditorSize = { width: number; height: number };
type EditorResizeDirection = "right" | "bottom" | "corner";

function getEditorSizeBounds() {
  const maxWidth = Math.max(1, window.innerWidth - EDITOR_VIEWPORT_MARGIN);
  const maxHeight = Math.max(1, window.innerHeight - EDITOR_VIEWPORT_MARGIN);
  return {
    minWidth: Math.min(EDITOR_MIN_WIDTH, maxWidth),
    minHeight: Math.min(EDITOR_MIN_HEIGHT, maxHeight),
    maxWidth,
    maxHeight,
  };
}

function clampEditorSize(size: EditorSize): EditorSize {
  const bounds = getEditorSizeBounds();
  return {
    width: Math.min(bounds.maxWidth, Math.max(bounds.minWidth, size.width)),
    height: Math.min(bounds.maxHeight, Math.max(bounds.minHeight, size.height)),
  };
}

function getInitialEditorSize(): EditorSize {
  const bounds = getEditorSizeBounds();
  const compact = window.innerWidth <= 800 || window.innerHeight <= 640;
  return clampEditorSize({
    width: compact
      ? bounds.maxWidth
      : Math.min(1100, window.innerWidth * 0.9),
    height: compact
      ? bounds.maxHeight
      : window.innerHeight * 0.8,
  });
}

function EditorDialog({
  session,
  onClose,
  onSessionClosed,
  onSessionCloseError,
}: {
  session: EditorSession;
  onClose: () => void;
  onSessionClosed: () => void;
  onSessionCloseError: (error: unknown) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const editorRef = useRef<{ destroyEditor?: () => void } | undefined>(
    undefined,
  );
  const closeTimer = useRef<number | undefined>(undefined);
  const resizeCleanup = useRef<(() => void) | undefined>(undefined);
  const sessionClosed = useRef(onSessionClosed);
  const sessionCloseError = useRef(onSessionCloseError);
  const [size, setSize] = useState<EditorSize>(getInitialEditorSize);
  const [error, setError] = useState("");
  const mountId = `onlyoffice-editor-${session.session.id}`;
  const documentTitle = (() => {
    const document = session.config.document;
    if (!document || typeof document !== "object" || !("title" in document))
      return "Document editor";
    return typeof document.title === "string" ? document.title : "Document editor";
  })();
  useEffect(() => {
    sessionClosed.current = onSessionClosed;
    sessionCloseError.current = onSessionCloseError;
  }, [onSessionCloseError, onSessionClosed]);
  useEffect(() => {
    const keepInViewport = () => setSize((current) => clampEditorSize(current));
    window.addEventListener("resize", keepInViewport);
    return () => {
      window.removeEventListener("resize", keepInViewport);
      resizeCleanup.current?.();
    };
  }, []);
  const startResize = (
    direction: EditorResizeDirection,
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeCleanup.current?.();
    const startingSize = dialog.current?.getBoundingClientRect() ?? {
      width: size.width,
      height: size.height,
    };
    const startX = event.clientX;
    const startY = event.clientY;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor =
      direction === "right"
        ? "ew-resize"
        : direction === "bottom"
          ? "ns-resize"
          : "nwse-resize";

    const move = (moveEvent: PointerEvent) => {
      setSize(
        clampEditorSize({
          width:
            direction === "bottom"
              ? startingSize.width
              : startingSize.width + moveEvent.clientX - startX,
          height:
            direction === "right"
              ? startingSize.height
              : startingSize.height + moveEvent.clientY - startY,
        }),
      );
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      if (resizeCleanup.current === cleanup) resizeCleanup.current = undefined;
    };
    const cleanup = stop;
    resizeCleanup.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
  useEffect(() => {
    const mount = container.current;
    if (closeTimer.current !== undefined) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
    let script: HTMLScriptElement | undefined;
    let scriptLoaded = false;
    let cancelled = false;
    const start = () => {
      try {
        if (cancelled || !window.DocsAPI || !mount) return;
        // Document Server owns this node. A new session must never inherit an
        // iframe that a previous instance creates asynchronously.
        mount.replaceChildren();
        editorRef.current = new window.DocsAPI.DocEditor(
          mountId,
          session.config,
        );
      } catch {
        if (!cancelled) setError("The document editor could not be opened.");
      }
    };
    if (window.DocsAPI) start();
    else {
      script = document.createElement("script");
      script.src = session.documentServer.apiUrl;
      script.async = true;
      script.onload = () => {
        scriptLoaded = true;
        start();
      };
      script.onerror = () => {
        if (!cancelled) setError("The document editor is unavailable.");
      };
      document.head.append(script);
    }
    return () => {
      cancelled = true;
      // Keep a successfully loaded DocsAPI script: DocsAPI remains global and
      // removing its defining element while reusing that global corrupts the
      // next editor initialization in some browsers. An unfinished load is
      // still removed so its callback cannot mount after cleanup.
      if (script && !scriptLoaded) script.remove();
      editorRef.current?.destroyEditor?.();
      editorRef.current = undefined;
      mount?.replaceChildren();
      // Strict Mode immediately replays effects in development. Deferring the
      // close lets the replacement effect cancel it, while a real unmount
      // still closes the server-side session.
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = undefined;
        void api.closeEditorSession(session.session.id).then(
          () => sessionClosed.current(),
          (requestError: unknown) => sessionCloseError.current(requestError),
        );
      }, 0);
    };
  }, [mountId, session]);
  return (
    <div className="editor-backdrop">
      <section
        ref={dialog}
        className="editor-dialog"
        style={{ width: size.width, height: size.height }}
        role="dialog"
        aria-modal="true"
        aria-label={`Document editor: ${documentTitle}`}
      >
        <header>
          <span>{session.session.mode === "EDIT" ? "Editing" : "Viewing"}: {documentTitle}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Close editor"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="editor-body">
          {error ? (
            <div className="editor-error">{error}</div>
          ) : (
            <div id={mountId} ref={container} className="editor-frame" />
          )}
        </div>
        <div
          className="editor-resize-handle editor-resize-right"
          aria-hidden="true"
          onPointerDown={(event) => startResize("right", event)}
        />
        <div
          className="editor-resize-handle editor-resize-bottom"
          aria-hidden="true"
          onPointerDown={(event) => startResize("bottom", event)}
        />
        <div
          className="editor-resize-handle editor-resize-corner"
          aria-hidden="true"
          onPointerDown={(event) => startResize("corner", event)}
        />
      </section>
    </div>
  );
}

function PreviewDialog({
  preview,
  onClose,
  onDownload,
}: {
  preview: Preview;
  onClose: () => void;
  onDownload: () => Promise<void>;
}) {
  const dialog = useDialogFocus();
  const [state, setState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const [downloadError, setDownloadError] = useState("");
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  const unavailable = previewIsUnavailable(preview);
  const session = unavailable ? null : preview;
  const type = session?.mimeType.toLowerCase();
  const retry = () => {
    setState("loading");
    setAttempt((current) => current + 1);
  };
  async function download() {
    setDownloadError("");
    try {
      await onDownload();
    } catch (error) {
      setDownloadError(displayError(error));
    }
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialog}
        className="preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${preview.filename}`}
      >
        <header>
          <span>{preview.filename}</span>
          <div>
            {preview.canDownload && (
              <button type="button" className="button" onClick={() => void download()}>
                Download
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="Close preview"
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </div>
        </header>
        <div className="preview-content" aria-busy={state === "loading"}>
          {unavailable ? (
            <PreviewState
              title="Preview unavailable"
              message="This file type can’t be previewed here."
              downloadError={downloadError}
            />
          ) : state === "error" ? (
            <PreviewState
              title="Preview is unavailable"
              message="The file could not be loaded for preview."
              onRetry={retry}
              downloadError={downloadError}
            />
          ) : (
            <>
              {state === "loading" && <div className="preview-loading" role="status">Loading preview…</div>}
              {type?.startsWith("image/") ? (
                <img key={attempt} src={session!.contentUrl} alt={session!.filename} onLoad={() => setState("ready")} onError={() => setState("error")} />
              ) : type?.startsWith("video/") ? (
                <video key={attempt} src={session!.contentUrl} controls preload="metadata" onLoadedMetadata={() => setState("ready")} onError={() => setState("error")} />
              ) : (
                <iframe key={attempt} title={session!.filename} src={session!.contentUrl} onLoad={() => setState("ready")} onError={() => setState("error")} />
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function PreviewState({
  title,
  message,
  onRetry,
  downloadError,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
  downloadError: string;
}) {
  return (
    <div className="preview-state" role="status">
      <strong>{title}</strong>
      <span>{message}</span>
      {downloadError && <span role="alert">{downloadError}</span>}
      {onRetry && <button type="button" className="button" onClick={onRetry}>Retry</button>}
    </div>
  );
}
declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (
        elementId: string,
        config: Record<string, unknown>,
      ) => { destroyEditor?: () => void };
    };
  }
}
export default App;
