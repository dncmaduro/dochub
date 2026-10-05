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
import { useTranslation } from "react-i18next";
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
import { changeLocale, getLocale, translate as t, type Locale } from "./i18n";
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
type ActiveEditorSession = EditorSession & {
  nodeId: string;
  canEdit: boolean;
};
type OnlyOfficeEditor = { destroyEditor?: () => void };
type ManagedOnlyOfficeEditor = {
  editor: OnlyOfficeEditor;
  disposed: boolean;
};

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
    : t("errors.generic");
}
function onlyOfficeErrorMessage(error: unknown) {
  if (!error || typeof error !== "object") return t("editor.failed");
  const value = error as Record<string, unknown>;
  const data = value.data && typeof value.data === "object"
    ? value.data as Record<string, unknown>
    : value;
  const code = typeof data.errorCode === "string" || typeof data.errorCode === "number"
    ? String(data.errorCode)
    : "";
  const description = typeof data.errorDescription === "string"
    ? data.errorDescription
    : "";
  const details = [code, description].filter(Boolean).join(": ");
  return details ? `${t("editor.failed")} (${details})` : t("editor.failed");
}
function hasCapability(node: Node, capability: string) {
  return node.capabilities.includes(capability);
}
function isOnlyOfficeEditableFile(name: string) {
  return /\.(doc|docx|xls|xlsx|ppt|pptx)$/i.test(name);
}
async function openFileActivation(
  node: Node,
  setEditor: (session: ActiveEditorSession) => void,
  setPreview: (preview: Preview) => void,
  onError: (notice: Notice) => void,
) {
  try {
    if (isOnlyOfficeEditableFile(node.name) && hasCapability(node, "PREVIEW")) {
      const session = await api.createEditorSession(node.id, "VIEW");
      setEditor({
        ...session,
        nodeId: node.id,
        canEdit: hasCapability(node, "EDIT"),
      });
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
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "—"
    : new Intl.DateTimeFormat(
        getLocale() === "vi" ? "vi-VN" : "en-US",
        getLocale() === "vi"
          ? { day: "2-digit", month: "2-digit", year: "numeric" }
          : {
              month: "short",
              day: "numeric",
              year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
            },
      ).format(date);
}
function formatBytes(value: string) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const locale = getLocale() === "vi" ? "vi-VN" : "en-US";
  const number = (amount: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(amount);
  if (bytes < 1024) return `${number(bytes)} ${t("files.units.bytes")}`;
  if (bytes < 1024 * 1024) return `${number(bytes / 1024)} ${t("files.units.kilobytes")}`;
  return `${number(bytes / (1024 * 1024))} ${t("files.units.megabytes")}`;
}
function formatVersionSource(source: FileVersion["source"]) {
  return t(`versions.sources.${source}`);
}
function systemRoleLabel(role: SystemRole) {
  return t(`roles.${role}`);
}
function userStatusLabel(status: string) {
  return t(`statuses.${status}`, { defaultValue: status });
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
        <button type="button" aria-label={t("common.close")} onClick={onDismiss}>
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
  useTranslation();
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
    return <div className="auth-state">{t("auth.checkingSession")}</div>;
  if (!authenticated) return <SignIn />;
  if (!profile) return <div className="auth-state">{t("auth.loadingAccount")}</div>;
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
  return <div className="content-state"><h1>{t("admin.accessDenied")}</h1><p>{t("admin.askAdministrator")}</p></div>;
}

function AdminApp({ tab }: { tab: "users" | "groups" }) {
  return <><PageHeader title={<h1 className="page-title">{t("admin.title")}</h1>} /><section className="admin-content" aria-label={t("admin.title")}>
    <div className="admin-intro"><h2>{t("admin.title")}</h2><p>{t("admin.description")}</p></div>
    <div className="admin-tabs" role="tablist" aria-label={t("admin.sections")}>
      <button type="button" role="tab" aria-selected={tab === "users"} className={tab === "users" ? "is-active" : ""} onClick={() => navigateAdmin("users")}>{t("admin.users")}</button>
      <button type="button" role="tab" aria-selected={tab === "groups"} className={tab === "groups" ? "is-active" : ""} onClick={() => navigateAdmin("groups")}>{t("admin.groups")}</button>
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
    setNotice({ tone: "success", message: t("admin.userAdded") });
  }
  async function action(user: AdminUser, kind: "role" | "status") {
    if (kind === "status" && user.status !== "SUSPENDED" && !window.confirm(t("admin.suspendConfirm", { name: user.displayName }))) return;
    setOpenMenuId(null);
    try { const updated = kind === "role" ? await api.updateAdminUser(user.id, { systemRole: user.systemRole === "ADMIN" ? "MEMBER" : "ADMIN" }) : user.status === "SUSPENDED" ? await api.reactivateAdminUser(user.id) : await api.suspendAdminUser(user.id); setUsers((items) => items.map((item) => item.id === user.id ? updated : item)); } catch (error) { setNotice({ tone: "error", message: displayError(error) }); }
  }
  const matching = users.filter((user) => `${user.displayName} ${user.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <Toast notice={notice} onDismiss={() => setNotice(null)} />
    <div className="admin-section-header"><div><h3>{t("admin.users")}</h3><p>{t("admin.usersDescription")}</p></div><button type="button" className="button button-primary" onClick={() => setAddOpen(true)}><Icon name="plus" size={16} />{t("admin.addUser")}</button></div>
    <input className="admin-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("admin.searchUsers")} aria-label={t("admin.searchUsers")} />
    <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t("common.name")}</th><th>{t("common.email")}</th><th>{t("common.role")}</th><th>{t("common.status")}</th><th>{t("common.actions")}</th></tr></thead><tbody>{matching.map((user) => <AdminUserRow key={user.id} user={user} menuOpen={openMenuId === user.id} onToggleMenu={() => setOpenMenuId((open) => open === user.id ? null : user.id)} onCloseMenu={() => setOpenMenuId(null)} onAction={(kind) => void action(user, kind)} />)}</tbody></table></div>
    {addOpen && <AddUserDialog onClose={() => setAddOpen(false)} onSubmit={create} />}
  </>;
}

function AdminUserRow({ user, menuOpen, onToggleMenu, onCloseMenu, onAction }: { user: AdminUser; menuOpen: boolean; onToggleMenu: () => void; onCloseMenu: () => void; onAction: (kind: "role" | "status") => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <tr><td>{user.displayName}</td><td>{user.email}</td><td>{systemRoleLabel(user.systemRole)}</td><td>{userStatusLabel(user.status)}</td><td className="row-actions">
    <button ref={trigger} type="button" className="icon-button" aria-label={t("admin.actionsFor", { name: user.displayName })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={onToggleMenu}><Icon name="more" /></button>
    {menuOpen && <RowMenu id={`admin-user-menu-${user.id}`} trigger={trigger} onClose={onCloseMenu}>
      <button type="button" role="menuitem" onClick={() => { onCloseMenu(); onAction("role"); }}>{user.systemRole === "ADMIN" ? t("admin.makeMember") : t("admin.makeAdmin")}</button>
      <div className="row-menu-divider" />
      <button type="button" role="menuitem" className={user.status === "SUSPENDED" ? "" : "menu-danger"} onClick={() => { onCloseMenu(); onAction("status"); }}>{user.status === "SUSPENDED" ? t("admin.reactivate") : t("admin.suspend")}</button>
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
      setError(t("admin.userRequired"));
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
    <header className="dialog-header"><div><h2 id="add-user-title">{t("admin.addUser")}</h2><p>{t("admin.addGoogleAccount")}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label={t("common.close")}><Icon name="close" size={16} /></button></header>
    <form onSubmit={(event) => void submit(event)}>
      <label htmlFor="add-user-name">{t("admin.displayName")}</label><input id="add-user-name" name="displayName" required maxLength={200} data-dialog-initial-focus />
      <label htmlFor="add-user-email">{t("admin.googleEmail")}</label><input id="add-user-email" name="email" type="email" required maxLength={320} />
      <label htmlFor="add-user-role">{t("common.role")}</label><select id="add-user-role" name="systemRole" defaultValue="MEMBER" required><option value="MEMBER">{t("roles.MEMBER")}</option><option value="ADMIN">{t("roles.ADMIN")}</option></select>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button" onClick={onClose} disabled={pending}>{t("common.cancel")}</button><button type="submit" className="button button-primary" disabled={pending}>{pending ? t("admin.addUser") + "…" : t("admin.addUser")}</button></div>
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
  async function rename(group: AdminGroup) { const name = window.prompt(t("admin.groupName"), group.name); if (!name || name === group.name) return; try { const updated = await api.updateAdminGroup(group.id, { name }); setGroups((items) => items.map((item) => item.id === group.id ? updated : item)); } catch (error) { setNotice({ tone: "error", message: displayError(error) }); } }
  const matching = groups.filter((group) => group.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <><Toast notice={notice} onDismiss={() => setNotice(null)} /><div className="admin-section-header"><div><h3>{t("admin.groups")}</h3><p>{t("admin.groupsDescription")}</p></div><form className="admin-inline-form" onSubmit={create}><input required name="name" placeholder={t("admin.newGroupName")} maxLength={200} aria-label={t("admin.newGroupName")} /><button className="button button-primary">{t("admin.newGroup")}</button></form></div><input className="admin-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("admin.searchGroups")} aria-label={t("admin.searchGroups")} />{groups.length === 0 || matching.length === 0 ? <div className="admin-empty"><h3>{groups.length === 0 ? t("admin.noGroupsYet") : t("admin.noGroupsFound")}</h3><p>{groups.length === 0 ? t("admin.createGroupHint") : t("admin.tryDifferentSearch")}</p></div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t("admin.groupName")}</th><th>{t("common.members")}</th><th>{t("common.actions")}</th></tr></thead><tbody>{matching.map((group) => <><tr key={group.id}><td>{group.name}</td><td>{new Intl.NumberFormat(getLocale() === "vi" ? "vi-VN" : "en-US").format(group.memberCount)}</td><td><button className="button" onClick={() => void rename(group)}>{t("admin.rename")}</button><button className="button" onClick={() => void toggleMembers(group)}>{members[group.id] ? t("admin.closeMembers") : t("admin.manageMembers")}</button></td></tr>{members[group.id] && <tr key={`${group.id}-members`}><td colSpan={3}><select defaultValue="" onChange={(event) => { if (event.target.value) void add(group.id, event.target.value); event.currentTarget.value = ""; }}><option value="">{t("admin.addUserToGroup")}</option>{users.filter((user) => !members[group.id].some((member) => member.id === user.id)).map((user) => <option key={user.id} value={user.id}>{user.displayName} — {user.email}</option>)}</select>{members[group.id].map((user) => <div className="admin-member" key={user.id}>{user.displayName} <button className="button" onClick={() => void remove(group.id, user.id)}>{t("common.remove")}</button></div>)}</td></tr>}</>)}</tbody></table></div>}
  </>;
}

function ProfileApp({ profile, onSignOut }: { profile: CurrentUser; onSignOut: () => void }) {
  return <>
    <PageHeader title={<h1 className="page-title">{t("profile.title")}</h1>} />
    <section className="profile-content" aria-label={t("profile.title")}>
      <div className="profile-heading"><h2>{t("profile.account")}</h2><p>{t("profile.description")}</p></div>
      <dl className="profile-details">
        <div><dt>{t("common.name")}</dt><dd>{profile.displayName}</dd></div>
        <div><dt>{t("common.email")}</dt><dd>{profile.email}</dd></div>
        <div><dt>{t("common.role")}</dt><dd>{systemRoleLabel(profile.systemRole)}</dd></div>
        <div><dt>{t("common.status")}</dt><dd>{userStatusLabel(profile.status)}</dd></div>
        <div><dt>{t("profile.signInMethod")}</dt><dd>{t("profile.googleStatus", { status: profile.googleConnected ? t("profile.connected") : t("profile.notConnected") })}</dd></div>
      </dl>
      <button type="button" className="button" onClick={onSignOut}>{t("account.signOut")}</button>
    </section>
  </>;
}

function SignIn() {
  const [pending, setPending] = useState(false);
  return (
    <main className="sign-in">
      <section>
        <Icon name="drive" size={30} />
        <h1>Docs Hub</h1>
        <p>{t("auth.signInDescription")}</p>
        <a className="button button-primary" href={api.googleAuthUrl()} onClick={() => setPending(true)}>
          {pending ? t("auth.signingIn") : t("auth.signInWithGoogle")}
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
        {t("files.search")}
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
        placeholder={t("files.search")}
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
      <nav aria-label={t("nav.main")}>
        <button
          className={`nav-item${active === "drive" ? " is-active" : ""}`}
          type="button"
          onClick={() => navigate(null)}
        >
          <Icon name="folder" />
          <span>{t("nav.files")}</span>
        </button>
        <button
          className={`nav-item${active === "recent" ? " is-active" : ""}`}
          type="button"
          onClick={() => navigateCollection("recent")}
        >
          <Icon name="recent" />
          <span>{t("nav.recent")}</span>
        </button>
        <button
          className={`nav-item${active === "favorites" ? " is-active" : ""}`}
          type="button"
          onClick={() => navigateCollection("favorites")}
        >
          <Icon name="star" />
          <span>{t("nav.favorites")}</span>
        </button>
        <button
          className={`nav-item${active === "trash" ? " is-active" : ""}`}
          type="button"
          onClick={navigateTrash}
        >
          <Icon name="trash" />
          <span>{t("nav.trash")}</span>
        </button>
        {canAdmin && <>
          <div className="sidebar-divider" />
          <button className={`nav-item${active === "admin" ? " is-active" : ""}`} type="button" onClick={() => navigateAdmin()}><Icon name="settings" /><span>{t("nav.admin")}</span></button>
        </>}
      </nav>
      <AccountMenu profile={profile} onSignOut={onSignOut} />
    </aside>
  );
}

function AccountMenu({ profile, onSignOut }: { profile: CurrentUser; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
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
      const width = Math.min(triggerRect.width, window.innerWidth);
      menuElement.style.width = `${width}px`;
      const menuRect = menuElement.getBoundingClientRect();
      const gap = 8;
      const maxLeft = Math.max(0, window.innerWidth - menuRect.width);
      const left = Math.min(maxLeft, Math.max(0, triggerRect.left));

      const preferredAbove = triggerRect.top - menuRect.height - gap;
      const preferredBelow = triggerRect.bottom + gap;
      const preferredTop = preferredAbove >= 0 ? preferredAbove : preferredBelow;
      const maxTop = Math.max(0, window.innerHeight - menuRect.height);
      const top = Math.min(maxTop, Math.max(0, preferredTop));

      setPosition({ top, left, width });
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
      <span className="account-copy"><strong>{t("account.myAccount")}</strong><small>{profile.displayName}</small></span>
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
          width: position?.width,
          visibility: position ? "visible" : "hidden",
        }}
      >
        <div className="account-menu-profile"><strong>{profile.displayName}</strong><span>{profile.email}</span><small>{systemRoleLabel(profile.systemRole)}</small></div>
        <div className="account-menu-divider" />
        <button type="button" role="menuitem" onClick={() => go(navigateProfile)}>{t("account.profile")}</button>
        {canAdmin && <button type="button" role="menuitem" onClick={() => go(() => navigateAdmin())}>{t("nav.admin")}</button>}
        <div className="account-menu-language" role="group" aria-label={t("account.language")}>
          <span>{t("account.language")}</span>
          {(["vi", "en"] as Locale[]).map((locale) => <button key={locale} type="button" role="menuitemradio" aria-checked={getLocale() === locale} onClick={() => void changeLocale(locale)}>{locale === "vi" ? t("account.languageVietnamese") : t("account.languageEnglish")}{getLocale() === locale ? " ✓" : ""}</button>)}
        </div>
        <div className="account-menu-divider" />
        <button type="button" role="menuitem" onClick={() => go(onSignOut)}>{t("account.signOut")}</button>
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
  const [editor, setEditor] = useState<ActiveEditorSession | null>(null);
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
    setNotice({ tone: "success", message: t("files.created", { name: node.name }) });
  }
  async function rename(node: Node, name: string) {
    const updated = await api.renameNode(node.id, name);
    setNodes((items) =>
      items
        .map((item) => (item.id === node.id ? updated : item))
        .sort(compareNodes),
    );
    setNotice({ tone: "success", message: t("files.renamed") });
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
        message: t("files.uploaded", { name: result.node.name }),
      });
    } catch (requestError) {
      setNotice({ tone: "error", message: displayError(requestError) });
    }
  }
  async function openFile(node: Node) {
    await openFileActivation(node, setEditor, setPreview, setNotice);
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
    setNotice({ tone: "success", message: t("files.movedToTrash", { name: node.name }) });
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
        message: isFavorite ? t("files.favoriteRemoved") : t("files.favoriteAdded"),
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
              aria-label={t("files.refresh")}
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
                  {t("files.newFolder")}
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => uploadInput.current?.click()}
                >
                  <Icon name="upload" />
                  {t("files.upload")}
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
                {t("files.rootAdminOnly")}
              </span>
            )}
        </PageHeader>
        <Toast notice={notice} onDismiss={() => setNotice(null)} />
        <section className="drive-content" aria-label={t("files.title")}>
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
              onNotice={setNotice}
              favoriteIds={favoriteIds}
              onFavorite={toggleFavorite}
            />
          )}
        </section>
      {createOpen && (
        <NameDialog
          title={t("files.newFolder")}
          action={t("common.create")}
          onClose={() => setCreateOpen(false)}
          onSubmit={createFolder}
        />
      )}
      {renameNode && (
        <NameDialog
          title={t("files.rename")}
          action={t("common.save")}
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
          title={t("files.moveToTrash")}
          message={t("files.moveToTrashConfirm", { name: trashNode.name })}
          action={t("files.moveToTrash")}
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
    <nav className="breadcrumbs" aria-label={t("nav.breadcrumb")}>
      <button type="button" onClick={() => navigate(null)}>
        {t("nav.files")}
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
  onNotice,
  favoriteIds,
  onFavorite,
  dateLabel = t("common.modified"),
}: {
  nodes: Node[];
  onFolder: (id: string) => void;
  onRename: (node: Node) => void;
  onShare: (node: Node) => void;
  onTrash: (node: Node) => void;
  onVersions: (node: Node) => void;
  onOpen: (node: Node) => void;
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
            <th scope="col">{t("common.name")}</th>
            <th scope="col">{dateLabel}</th>
            <th scope="col">
              <span className="visually-hidden">{t("files.tableActions")}</span>
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
          aria-label={t("files.fileActions", { name: node.name })}
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
              {isFavorite ? t("files.unfavorite") : t("files.favorite")}
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
                ? t("files.openFolder")
                : isOnlyOfficeEditableFile(node.name) && hasCapability(node, "PREVIEW")
                  ? t("files.open")
                  : hasCapability(node, "PREVIEW")
                    ? t("files.preview")
                    : t("common.download")}
            </button>
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
                {t("common.download")}
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
                {t("files.rename")}
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
                {t("files.versionHistory")}
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
                {t("files.share")}
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
                {t("files.moveToTrash")}
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
          setLookupError(t("errors.directoryUnavailable"));
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
      onNotice({ tone: "success", message: t("share.linkCopied") });
    } catch {
      onNotice({ tone: "error", message: t("share.linkCopyFailed") });
    }
  }

  const principals = principalResults.filter((principal) => principal.type === principalType);
  const selectedName = selectedPrincipal
    ? selectedPrincipal.type === "USER"
      ? selectedPrincipal.displayName ?? t("principalTypes.USER")
      : selectedPrincipal.name ?? t("principalTypes.GROUP")
    : "";

  async function addPermission() {
    if (!selectedPrincipal) return;
    await mutate(
      () => selectedPrincipal.type === "USER"
        ? api.setUserPermission(node.id, selectedPrincipal.id, role)
        : api.setGroupPermission(node.id, selectedPrincipal.id, role),
      t("share.permissionAdded"),
      closeAddForm,
    );
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialog} className="dialog share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
        <header className="dialog-header">
          <div><h2 id="share-dialog-title">{t("share.title", { name: node.name })}</h2></div>
          <button type="button" className="icon-button" aria-label={t("share.close")} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        {error && <p className="form-error" role="alert">{error}</p>}
        {!sharing || !permissions ? (
          <p className="dialog-loading">{t("share.loading")}</p>
        ) : (
          <div className="share-body">
            <section className="share-section">
              <h3>{t("share.peopleWithAccess")}</h3>
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
                      t("share.permissionUpdated"),
                    )}
                    onRemove={() => void mutate(
                      () => api.removePermission(node.id, entry),
                      t("share.permissionRemoved"),
                    )}
                  />
                ))}
                {permissions.entries.length === 0 && <p className="muted-copy">{t("share.noDirectPermissions")}</p>}
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
                {addOpen ? t("common.close") : t("share.addPeopleOrGroups")}
              </button>
              {addOpen && (
                <div className="permission-add" aria-label={t("share.addPersonOrGroup")}>
                  <div className="principal-search-row">
                    <select
                      aria-label={t("share.searchType")}
                      value={principalType}
                      onChange={(event) => {
                        setPrincipalType(event.target.value as "USER" | "GROUP");
                        setSelectedPrincipal(null);
                      }}
                      disabled={pending}
                    >
                      <option value="USER">{t("share.people")}</option>
                      <option value="GROUP">{t("share.groups")}</option>
                    </select>
                    <input
                      ref={principalSearch}
                      aria-label={principalType === "USER" ? t("share.searchPeople") : t("share.searchGroups")}
                      value={principalQuery}
                      onChange={(event) => {
                        setPrincipalQuery(event.target.value);
                        setSelectedPrincipal(null);
                      }}
                      placeholder={principalType === "USER" ? t("share.searchPeople") : t("share.searchGroups")}
                      disabled={pending}
                    />
                  </div>
                  {lookupError && <p className="form-error" role="alert">{lookupError}</p>}
                  {principalQuery.trim().length < 2 ? (
                    <p className="muted-copy search-hint">{t("share.typeToSearch")}</p>
                  ) : principals.length > 0 ? (
                    <div className="principal-results" aria-label={t("share.searchResults")}>
                      {principals.map((principal) => {
                        const name = principal.type === "USER" ? principal.displayName ?? t("principalTypes.USER") : principal.name ?? t("principalTypes.GROUP");
                        const secondary = principal.type === "USER" ? principal.email ?? t("principalTypes.USER") : t("principalTypes.GROUP");
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
                            {selected && <span className="selected-label">{t("common.selected")}</span>}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="muted-copy search-hint">{principalType === "USER" ? t("share.noMatchingPeople") : t("share.noMatchingGroups")}</p>
                  )}
                  {selectedPrincipal && (
                    <div className="selected-principal">
                      <span>{t("share.sharingWith")} <strong>{selectedName}</strong></span>
                      <label>
                        <span className="visually-hidden">{t("share.roleFor", { name: selectedName })}</span>
                        <select aria-label={t("share.roleFor", { name: selectedName })} value={role} onChange={(event) => setRole(event.target.value as DocumentRole)} disabled={pending}>
                          <option value="VIEWER">{t("roles.VIEWER")}</option>
                          <option value="EDITOR">{t("roles.EDITOR")}</option>
                          <option value="OWNER">{t("roles.OWNER")}</option>
                        </select>
                      </label>
                      <button type="button" className="button button-primary" disabled={pending} onClick={() => void addPermission()}>
                        {pending ? `${t("common.add")}…` : t("common.add")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="share-section">
              <h3>{t("share.generalAccess")}</h3>
              <label className="access-setting">
                <span>
                  <strong>{sharing.publicAccess ? t("share.anyoneWithLink") : t("share.restricted")}</strong>
                  <small>{sharing.publicAccess ? t("share.anyoneCanView") : t("share.onlyPeopleCanView")}</small>
                </span>
                <span className="access-toggle">
                  <span>{t("share.anyoneWithLink")}</span>
                  <input
                    type="checkbox"
                    aria-label={t("share.anyoneCanViewAria")}
                    checked={sharing.publicAccess}
                    disabled={pending}
                    onChange={(event) => void mutate(
                      () => api.setPublicAccess(node.id, event.target.checked),
                      t("share.generalAccessUpdated"),
                    )}
                  />
                </span>
              </label>
              <div className="issued-link-row">
                <div className="issued-link-state">
                  <strong>{t("share.shareLink")}</strong>
                  <small>{!sharing.shareLink.exists ? t("share.noLinkCreated") : linkUrl ? t("share.linkReady") : t("share.activeLink")}</small>
                </div>
                {!sharing.shareLink.exists ? (
                  <button type="button" className="button" disabled={pending} onClick={() => void mutate(async () => {
                    const result = await api.createShareLink(node.id);
                    setLinkUrl(result.shareLink.url);
                  }, t("share.linkCreated"))}>{t("share.createLink")}</button>
                ) : linkUrl ? (
                  <div className="share-link">
                    <input readOnly value={linkUrl} aria-label={t("share.issuedLink")} />
                    <button type="button" className="button" onClick={() => void copyLink()}>{t("common.copy")}</button>
                  </div>
                ) : null}
              </div>
              {sharing.shareLink.exists && (
                <details className="link-options">
                  <summary>{t("share.linkOptions")}</summary>
                  <div className="link-option-actions">
                    <button type="button" className="text-button secondary-action" disabled={pending} onClick={() => void mutate(async () => {
                      const result = await api.resetShareLink(node.id);
                      setLinkUrl(result.shareLink.url);
                    }, t("share.linkReset"))}>{t("share.resetLink")}</button>
                    <button type="button" className="text-button secondary-action" disabled={pending} onClick={() => void mutate(async () => {
                      await api.revokeShareLink(node.id);
                      setLinkUrl(null);
                    }, t("share.linkRevoked"))}>{t("share.revokeLink")}</button>
                  </div>
                </details>
              )}
            </section>

            <details className="advanced-access">
              <summary>{t("share.advancedAccess")}</summary>
              <label className="inherit-setting">
                <input
                  type="checkbox"
                  checked={permissions.inheritPermissions}
                  disabled={pending}
                  onChange={(event) => {
                    const value = event.target.checked;
                    if (!value && !window.confirm(t("share.stopInheritanceConfirm"))) return;
                    void mutate(() => api.setInheritance(node.id, value), t("share.inheritanceUpdated"));
                  }}
                />
                <span>{t("share.inheritPermissions")}</span>
              </label>
            </details>
          </div>
        )}
        <footer className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>{t("common.done")}</button>
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
      ? `${entry.principal.displayName ?? t("principalTypes.USER")}${entry.principal.email ? ` — ${entry.principal.email}` : ""}`
      : (entry.principal.name ?? t("principalTypes.GROUP"));
  return (
    <div className="permission-row">
      <div>
        <strong>{label}</strong>
        <small>
          {entry.principalType === "USER"
            ? t("share.directUserPermission")
            : t("share.directGroupPermission")}
        </small>
      </div>
      <select
        aria-label={t("share.roleFor", { name: label })}
        value={entry.role}
        disabled={disabled}
        onChange={(event) => onRole(event.target.value as DocumentRole)}
      >
        <option value="VIEWER">{t("roles.VIEWER")}</option>
        <option value="EDITOR">{t("roles.EDITOR")}</option>
        <option value="OWNER">{t("roles.OWNER")}</option>
      </select>
      <button
        type="button"
        className="text-button text-button-danger"
        disabled={disabled}
        onClick={onRemove}
      >
        {t("common.remove")}
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
  const [editor, setEditor] = useState<ActiveEditorSession | null>(null);
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
  function handleEditorSessionClosed() {
    void load();
  }
  function handleEditorSessionCloseError(requestError: unknown) {
    setNotice({ tone: "error", message: displayError(requestError) });
  }

  async function rename(node: Node, name: string) {
    const updated = await api.renameNode(node.id, name);
    setItems((current) => current.map((item) => item.id === node.id ? { ...item, ...updated } : item));
    setNotice({ tone: "success", message: t("files.renamed") });
  }

  async function moveToTrash(node: Node) {
    await api.moveToTrash(node.id);
    setItems((current) => current.filter((item) => item.id !== node.id));
    setFavoriteIds((current) => {
      const next = new Set(current);
      next.delete(node.id);
      return next;
    });
    setNotice({ tone: "success", message: t("files.movedToTrash", { name: node.name }) });
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
      setNotice({ tone: "success", message: isFavorite ? t("files.favoriteRemoved") : t("files.favoriteAdded") });
    } catch (requestError) {
      setNotice({ tone: "error", message: displayError(requestError) });
    }
  }

  const displayItems: Node[] = items.map((item) => ({
    ...item,
    updatedAt: kind === "recent" ? item.lastAccessedAt ?? item.updatedAt : item.favoritedAt ?? item.updatedAt,
  }));
  const title = kind === "recent" ? t("nav.recent") : t("nav.favorites");
  const emptyTitle = kind === "recent" ? t("search.noRecent") : t("search.noFavorites");
  return (
    <>
        <PageHeader title={<h1 className="page-title">{title}</h1>}>
          <button type="button" className="icon-button" onClick={() => void load()} aria-label={t("files.refreshCollection", { name: title })}>
            <Icon name="refresh" />
          </button>
        </PageHeader>
        <section className="drive-content" aria-label={title}>
          {status === "loading" && <LoadingRows label={`${t("common.loading")} ${title.toLowerCase()}`} />}
          {status === "error" && <CollectionError title={title} message={error} onRetry={() => void load()} />}
          {status === "ready" && displayItems.length === 0 && <SearchState title={emptyTitle} />}
          {status === "ready" && displayItems.length > 0 && <FileList nodes={displayItems} onFolder={(id) => navigate(id)} onRename={setRenameNode} onShare={setShareNode} onTrash={setTrashNode} onVersions={setVersionNode} onOpen={openFile} onNotice={setNotice} favoriteIds={favoriteIds} onFavorite={toggleFavorite} dateLabel={kind === "recent" ? t("files.dateLastOpened") : t("files.dateAdded")} />}
        </section>
      <Toast notice={notice} onDismiss={() => setNotice(null)} />
      {renameNode && <NameDialog title={t("files.rename")} action={t("common.save")} initialValue={renameNode.name} onClose={() => setRenameNode(null)} onSubmit={(name) => rename(renameNode, name)} />}
      {shareNode && <ShareDialog node={shareNode} onClose={() => setShareNode(null)} onNotice={setNotice} />}
      {trashNode && <ConfirmDialog title={t("files.moveToTrash")} message={t("files.moveToTrashConfirm", { name: trashNode.name })} action={t("files.moveToTrash")} onClose={() => setTrashNode(null)} onConfirm={() => moveToTrash(trashNode)} onNotice={setNotice} />}
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
  return <div className="content-state"><h1>{t("files.collectionLoadFailed", { name: title })}</h1><p>{message}</p><button type="button" className="button" onClick={onRetry}>{t("common.retry")}</button></div>;
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
  const [editor, setEditor] = useState<ActiveEditorSession | null>(null);
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
          <div className="page-context"><h1 className="page-title">{t("search.title")}</h1></div>
          <SearchInput key={query} query={query} />
          <div className="toolbar-actions" />
        </header>
        <section className="drive-content" aria-label={t("search.results")}>
          {status === "idle" && <SearchState title={t("files.search")} message={t("search.enterQuery")} />}
          {status === "invalid" && <SearchState title={t("search.queryTooLong")} message={t("search.queryTooLongMessage")} />}
          {status === "loading" && <LoadingRows label={t("search.loadingResults")} />}
          {status === "error" && <SearchError message={error} onRetry={() => void retry()} />}
          {status === "ready" && items.length === 0 && <SearchState title={t("search.noFilesForQuery", { query: normalizedQuery })} />}
          {status === "ready" && items.length > 0 && (
            <>
              <SearchResultsTable items={items} locations={locations} onOpen={openItem} />
              {nextCursor && <div className="search-more"><button type="button" className="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? t("common.loading") : t("search.loadMore")}</button></div>}
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
  if (location === undefined) return t("search.loadingLocation");
  if (location === null) return t("search.locationUnavailable");
  const parents = location.items.slice(0, -1).map((item) => item.name);
  if (!parents.length) return location.truncated ? t("search.sharedLocation") : t("nav.files");
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
        <thead><tr><th scope="col">{t("common.name")}</th><th scope="col">{t("search.location")}</th><th scope="col">{t("common.type")}</th><th scope="col">{t("common.modified")}</th></tr></thead>
        <tbody>{items.map((item) => (
          <tr key={item.id}>
            <td><button type="button" className="file-name" onClick={() => void onOpen(item)}><Icon name={item.type === "FOLDER" ? "folder" : "file"} size={19} /><span>{item.name}</span></button></td>
            <td className="search-location" title={searchLocationLabel(locations[item.id])}>{searchLocationLabel(locations[item.id])}</td>
            <td className="search-type">{item.type === "FOLDER" ? t("search.folder") : t("search.file")}</td>
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
  return <div className="content-state search-state"><h1>{t("search.failed")}</h1><p>{message}</p><button type="button" className="button" onClick={onRetry}>{t("common.retry")}</button></div>;
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
      message: action === "restore" ? t("trash.restored", { name: item.name }) : t("trash.deleted", { name: item.name }),
    });
  }
  return (
    <>
        <PageHeader title={<h1 className="page-title">{t("trash.title")}</h1>}>
          <button type="button" className="icon-button" onClick={() => void load()} aria-label={t("trash.refresh")}>
            <Icon name="refresh" />
          </button>
        </PageHeader>
        <section className="drive-content" aria-label={t("trash.title")}>
          {status === "loading" && <LoadingRows />}
          {status === "error" && <ErrorState message={error} onRetry={() => void load()} />}
          {status === "ready" && items.length === 0 && <div className="content-state"><h1>{t("trash.empty")}</h1></div>}
          {status === "ready" && items.length > 0 && (
            <div className="file-table-wrap"><table className="file-table trash-table">
              <colgroup><col /><col className="trash-date-column" /><col className="trash-expiry-column" /><col className="trash-menu-column" /></colgroup>
              <thead><tr><th scope="col">{t("common.name")}</th><th scope="col">{t("trash.trashed")}</th><th scope="col">{t("trash.autoDelete")}</th><th scope="col"><span className="visually-hidden">{t("common.actions")}</span></th></tr></thead>
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
          title={confirmation.action === "restore" ? t("trash.restoreFromTrash") : t("trash.permanentlyDelete")}
          message={confirmation.action === "restore" ? t("trash.restoreOriginalConfirm", { name: confirmation.item.name }) : t("trash.deleteConfirm", { name: confirmation.item.name })}
          action={confirmation.action === "restore" ? t("files.restore") : t("files.deletePermanently")}
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
          aria-label={t("trash.actionsFor", { name: item.name })}
          aria-haspopup="menu"
          aria-controls={menuOpen ? `trash-menu-${item.trashOperationId}` : undefined}
          aria-expanded={menuOpen}
          onClick={onToggleMenu}
        >
          <Icon name="more" />
        </button>
        {menuOpen && (
          <RowMenu id={`trash-menu-${item.trashOperationId}`} trigger={trigger} onClose={onCloseMenu}>
            {item.canRestore && <button type="button" role="menuitem" onClick={() => { onCloseMenu(); onConfirm("restore"); }}>{t("files.restore")}</button>}
            {item.canPurge && <button type="button" role="menuitem" className="menu-danger" onClick={() => { onCloseMenu(); onConfirm("purge"); }}>{t("files.deletePermanently")}</button>}
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
    if (!window.confirm(t("versions.restoreConfirm", { number: version.versionNumber }))) return;
    setPending(version.id);
    setError("");
    try {
      await api.restoreVersion(node.id, version.id);
      await load();
      onNotice({ tone: "success", message: t("versions.restored") });
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
          <div><h2 id="version-dialog-title">{t("versions.title")}</h2><p>{node.name}</p></div>
          <button type="button" className="icon-button" aria-label={`${t("common.close")} ${t("versions.title")}`} onClick={onClose}><Icon name="close" /></button>
        </header>
        {error && <p className="form-error" role="alert">{error}</p>}
        {!versions ? <p className="dialog-loading">{t("versions.loading")}</p> : (
          <div className="version-list">{versions.map((version) => (
            <div className="version-row" key={version.id}>
              <div className="version-title-row">
                <strong>{t("versions.version", { number: version.versionNumber })}</strong>
                {version.isCurrent && <span className="version-current">{t("versions.current")}</span>}
              </div>
              <div className="version-metadata">
                <span>{formatDate(version.createdAt)}</span>
                <span>{formatVersionSource(version.source)}</span>
                <span>{formatBytes(version.sizeBytes)}</span>
              </div>
              <div className="version-actions">
                {hasCapability(node, "DOWNLOAD") && <button type="button" className="version-action" disabled={pending !== null} onClick={() => void api.downloadVersion(node, version).catch((requestError) => onNotice({ tone: "error", message: displayError(requestError) }))}>{t("versions.downloadVersion")}</button>}
                {!version.isCurrent && hasCapability(node, "RESTORE_VERSION") && <button type="button" className="version-action" disabled={pending !== null} onClick={() => void restore(version)}>{pending === version.id ? t("common.restoring") : t("versions.restoreThisVersion")}</button>}
              </div>
            </div>
          ))}</div>
        )}
        <footer className="dialog-actions"><button type="button" className="button" onClick={onClose}>{t("common.done")}</button></footer>
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
          <button type="button" className="icon-button" aria-label={`${t("common.close")} ${title}`} disabled={pending} onClick={onClose}>
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
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={`button${action === t("files.restore") ? " button-primary" : " button-danger"}`}
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
      setError(t("common.enterName"));
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
          <button type="button" className="icon-button" aria-label={`${t("common.close")} ${title}`} disabled={pending} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <form onSubmit={submit}>
          <label htmlFor="node-name">{t("common.name")}</label>
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
              {t("common.cancel")}
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
      <h1>{t("files.noFiles")}</h1>
      <p>{t("files.noFilesDescription")}</p>
      {canCreateHere && (
        <div>
          <button type="button" className="button" onClick={onFolder}>
            {t("files.newFolder")}
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={onUpload}
          >
            {t("files.upload")}
          </button>
        </div>
      )}
      {!canCreateHere && <p>{t("files.rootAdminOnly")}</p>}
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
      <h1>{t("files.folderLoadFailed")}</h1>
      <p>{message}</p>
      <button type="button" className="button" onClick={onRetry}>
        {t("common.retry")}
      </button>
    </div>
  );
}
function LoadingRows({ label = t("files.loadingFolder") }: { label?: string }) {
  return (
    <div className="loading-list" role="status">
      <span>{label}…</span>
    </div>
  );
}

const EDITOR_VIEWPORT_MARGIN = 30;
const EDITOR_MIN_WIDTH = 720;
const EDITOR_MIN_HEIGHT = 500;

type EditorSize = { width: number; height: number };
type EditorResizeDirection = "right" | "bottom" | "corner";

function getEditorSizeBounds() {
  const maxWidth = Math.max(1, window.innerWidth - EDITOR_VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(1, window.innerHeight - EDITOR_VIEWPORT_MARGIN * 2);
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
  return clampEditorSize({
    width: bounds.maxWidth,
    height: bounds.maxHeight,
  });
}

function EditorDialog({
  session,
  onClose,
  onSessionClosed,
  onSessionCloseError,
}: {
  session: ActiveEditorSession;
  onClose: () => void;
  onSessionClosed: () => void;
  onSessionCloseError: (error: unknown) => void;
}) {
  // React owns this stable host. DocsAPI owns every child inside it because
  // DocEditor replaces its placeholder with an iframe and restores it on close.
  const editorHost = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const editorRef = useRef<ManagedOnlyOfficeEditor | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const resizeCleanup = useRef<(() => void) | undefined>(undefined);
  const switchingRef = useRef(false);
  const closedSessionIds = useRef(new Set<string>());
  const sessionClosed = useRef(onSessionClosed);
  const sessionCloseError = useRef(onSessionCloseError);
  const [activeSession, setActiveSession] = useState(session);
  const [size, setSize] = useState<EditorSize>(getInitialEditorSize);
  const [error, setError] = useState("");
  const [editorState, setEditorState] = useState<"loading" | "ready" | "error">("loading");
  const [switching, setSwitching] = useState(false);
  const activeSessionRef = useRef(activeSession);
  const mountId = `onlyoffice-editor-${activeSession.session.id}`;
  const documentTitle = (() => {
    const document = activeSession.config.document;
    if (!document || typeof document !== "object" || !("title" in document))
      return t("editor.title");
    return typeof document.title === "string" ? document.title : t("editor.title");
  })();
  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);
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
  const closeSession = useCallback(async (target: ActiveEditorSession) => {
    if (closedSessionIds.current.has(target.session.id)) return false;
    closedSessionIds.current.add(target.session.id);
    try {
      await api.closeEditorSession(target.session.id);
      return true;
    } catch (requestError) {
      closedSessionIds.current.delete(target.session.id);
      throw requestError;
    }
  }, []);
  const disposeEditor = useCallback((owned: ManagedOnlyOfficeEditor | undefined = editorRef.current, reportError = true) => {
    if (!owned || owned.disposed) return;
    owned.disposed = true;
    try {
      owned.editor.destroyEditor?.();
    } catch (destroyError) {
      if (reportError) setError(onlyOfficeErrorMessage(destroyError));
    } finally {
      if (editorRef.current === owned) editorRef.current = undefined;
    }
  }, []);
  const cleanEditorHost = useCallback(() => {
    // The host has no React children; its contents belong entirely to DocsAPI.
    editorHost.current?.replaceChildren();
  }, []);
  const switchMode = async (mode: "VIEW" | "EDIT") => {
    const current = activeSessionRef.current;
    if (switchingRef.current || current.session.mode === mode) return;
    switchingRef.current = true;
    setSwitching(true);
    setError("");
    setEditorState("loading");
    let currentSessionClosed = false;
    try {
      // VIEW sessions close immediately. EDIT sessions must first let
      // ONLYOFFICE initiate its final callback before the API waits for it.
      if (current.session.mode === "EDIT") {
        disposeEditor();
        cleanEditorHost();
      }
      await closeSession(current);
      currentSessionClosed = true;
      if (current.session.mode === "VIEW") {
        disposeEditor();
        cleanEditorHost();
      }
      const next = await api.createEditorSession(current.nodeId, mode);
      setActiveSession({
        ...next,
        nodeId: current.nodeId,
        canEdit: current.canEdit,
      });
    } catch (requestError) {
      if (!currentSessionClosed) {
        setActiveSession({ ...current });
      } else if (mode === "EDIT" && current.session.mode === "VIEW") {
        try {
          const recovery = await api.createEditorSession(current.nodeId, "VIEW");
          setActiveSession({
            ...recovery,
            nodeId: current.nodeId,
            canEdit: current.canEdit,
          });
        } catch (recoveryError) {
          setEditorState("error");
          setError(displayError(recoveryError));
        }
      } else {
        setEditorState("error");
        setError(displayError(requestError));
      }
      onSessionCloseError(requestError);
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  };
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
    const host = editorHost.current;
    if (closeTimer.current !== undefined) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
    let script: HTMLScriptElement | undefined;
    let scriptLoaded = false;
    let cancelled = false;
    let editor: ManagedOnlyOfficeEditor | undefined;
    const configuredEvents = activeSession.config.events && typeof activeSession.config.events === "object"
      ? activeSession.config.events as Record<string, unknown>
      : {};
    const callConfiguredEvent = (name: string, args: unknown[]) => {
      const callback = configuredEvents[name];
      if (typeof callback === "function") callback(...args);
    };
    const handleReady = (...args: unknown[]) => {
      if (!cancelled) setEditorState("ready");
      callConfiguredEvent("onAppReady", args);
    };
    const handleDocumentReady = (...args: unknown[]) => {
      if (!cancelled) setEditorState("ready");
      callConfiguredEvent("onDocumentReady", args);
    };
    const handleError = (...args: unknown[]) => {
      if (!cancelled) {
        setEditorState("error");
        setError(onlyOfficeErrorMessage(args[0]));
      }
      callConfiguredEvent("onError", args);
    };
    const handleWarning = (...args: unknown[]) => {
      callConfiguredEvent("onWarning", args);
    };
    const start = () => {
      try {
        if (cancelled || !window.DocsAPI || !host) {
          if (!cancelled) {
            setEditorState("error");
            setError(t("editor.failed"));
          }
          return;
        }
        // The host is deliberately the only React-owned node in this subtree.
        // DocsAPI owns the placeholder and iframe created inside it.
        host.replaceChildren();
        const placeholder = document.createElement("div");
        placeholder.id = mountId;
        host.appendChild(placeholder);
        const editorConfig = {
          ...activeSession.config,
          editorConfig: {
            ...(typeof activeSession.config.editorConfig === "object" && activeSession.config.editorConfig !== null ? activeSession.config.editorConfig : {}),
            lang: getLocale(),
          },
          events: {
            ...configuredEvents,
            onAppReady: handleReady,
            onDocumentReady: handleDocumentReady,
            onError: handleError,
            onWarning: handleWarning,
          },
        };
        const createdEditor = new window.DocsAPI.DocEditor(placeholder.id, editorConfig);
        editor = { editor: createdEditor, disposed: false };
        editorRef.current = editor;
        setEditorState("ready");
      } catch (constructionError) {
        if (!cancelled) {
          setEditorState("error");
          setError(onlyOfficeErrorMessage(constructionError));
        }
      }
    };
    if (window.DocsAPI) start();
    else {
      script = document.createElement("script");
      script.src = activeSession.documentServer.apiUrl;
      script.async = true;
      script.onload = () => {
        scriptLoaded = true;
        start();
      };
      script.onerror = () => {
        if (!cancelled) {
          setEditorState("error");
          setError(t("editor.unavailable"));
        }
      };
      document.head.append(script);
    }
    return () => {
      cancelled = true;
      // Keep a successfully loaded DocsAPI script: DocsAPI remains global and
      // removing its defining element while reusing that global corrupts the
      // next editor initialization in some browsers. An unfinished load is
      // still removed so its callback cannot mount after cleanup.
      if (script && !scriptLoaded && script.parentNode) {
        try {
          script.parentNode.removeChild(script);
        } catch {
          // Another cleanup may have removed the unfinished script already.
        }
      }
      disposeEditor(editor, false);
      host?.replaceChildren();
      // Strict Mode immediately replays effects in development. Deferring the
      // close lets the replacement effect cancel it, while a real unmount
      // still closes the server-side session.
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = undefined;
        void closeSession(activeSession).then(
          (closed) => closed && sessionClosed.current(),
          (requestError: unknown) => sessionCloseError.current(requestError),
        );
      }, 0);
    };
  }, [activeSession, cleanEditorHost, closeSession, disposeEditor, mountId]);
  return (
    <div className="editor-backdrop">
      <section
        ref={dialog}
        className="editor-dialog"
        style={{ width: size.width, height: size.height }}
        role="dialog"
        aria-modal="true"
        aria-label={t("editor.ariaTitle", { title: documentTitle })}
      >
        <header>
          <div className="editor-header-title">
            <span>{documentTitle}</span>
            <span className="editor-header-mode">
              {activeSession.session.mode === "EDIT" ? t("editor.editing") : t("editor.viewing")}
            </span>
          </div>
          <div className="editor-header-actions">
            {activeSession.canEdit && (
              <div
                className="editor-mode-control"
                role="group"
                aria-label={t("editor.mode")}
                aria-busy={switching}
              >
                <button
                  type="button"
                  aria-pressed={activeSession.session.mode === "VIEW"}
                  aria-label={t("editor.switchToView")}
                  disabled={switching || activeSession.session.mode === "VIEW"}
                  onClick={() => void switchMode("VIEW")}
                >
                  {t("editor.viewMode")}
                </button>
                <button
                  type="button"
                  aria-pressed={activeSession.session.mode === "EDIT"}
                  aria-label={t("editor.switchToEdit")}
                  disabled={switching || activeSession.session.mode === "EDIT"}
                  onClick={() => void switchMode("EDIT")}
                >
                  {t("editor.editMode")}
                </button>
              </div>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={t("editor.close")}
              disabled={switching}
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </div>
        </header>
        <div className="editor-body" aria-busy={switching || editorState === "loading"}>
          <div ref={editorHost} className="editor-host" />
          {(switching || editorState === "loading") && (
            <div className="editor-error" role="status">{t("editor.opening")}</div>
          )}
          {editorState === "error" && !switching && (
            <div className="editor-error" role="alert">
              <span>{error || t("editor.failed")}</span>
              <button type="button" className="button" onClick={onClose}>{t("common.close")}</button>
            </div>
          )}
        </div>
        <div
          className="editor-resize-handle editor-resize-right"
          role="separator"
          aria-label={t("editor.resize")}
          onPointerDown={(event) => startResize("right", event)}
        />
        <div
          className="editor-resize-handle editor-resize-bottom"
          role="separator"
          aria-label={t("editor.resize")}
          onPointerDown={(event) => startResize("bottom", event)}
        />
        <div
          className="editor-resize-handle editor-resize-corner"
          role="separator"
          aria-label={t("editor.resize")}
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
        aria-label={`${t("preview.unavailableTitle")} ${preview.filename}`}
      >
        <header>
          <span>{preview.filename}</span>
          <div>
            {preview.canDownload && (
              <button type="button" className="button" onClick={() => void download()}>
                {t("common.download")}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={t("preview.close")}
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </div>
        </header>
        <div className="preview-content" aria-busy={state === "loading"}>
          {unavailable ? (
            <PreviewState
              title={t("preview.unavailableTitle")}
              message={t("preview.unavailableMessage")}
              downloadError={downloadError}
            />
          ) : state === "error" ? (
            <PreviewState
              title={t("preview.failedTitle")}
              message={t("preview.failedMessage")}
              onRetry={retry}
              downloadError={downloadError}
            />
          ) : (
            <>
              {state === "loading" && <div className="preview-loading" role="status">{t("preview.loading")}</div>}
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
      {onRetry && <button type="button" className="button" onClick={onRetry}>{t("common.retry")}</button>}
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
