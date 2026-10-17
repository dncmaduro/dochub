import {
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
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
  type DriveFolderOption,
  type DriveIntegration,
  type DriveFile,
  type FolderTreeItem,
  type NodeTreeItem,
  type Breadcrumb,
  type AdminGroup,
  type AdminUser,
  type CollectionItem,
  type CurrentUser,
  type DocumentRole,
  type FileVersion,
  type FileRevisionHistoryItem,
  type VersionHistoryItem,
  type FilePreviewDescriptor,
  type Node,
  type NodeSortBy,
  type NodeSortDirection,
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
import { canAdministerAccounts, canManageDocuments } from "./system-role-policy";
import { DocumentViewer } from "./DocumentViewer";
import { SpreadsheetViewer } from "./SpreadsheetViewer";
import { PresentationViewer } from "./PresentationViewer";
import { TextFileViewer } from "./TextFileViewer";
import { ImageViewer } from "./ImageViewer";
import {
  createUploadQueueItems,
  runUploadQueue,
  type UploadQueueItem,
} from "./upload-queue";
import { confirmEditorNavigation, setActiveEditorDirty, type WorkspaceActions, type WorkspaceMode } from "./workspace";
import { clearRecoveryDraftsForUser, clearRecoveryUser, setRecoveryUser } from "./recovery-drafts";
import "./App.css";

const api = new ApiClient();
type Notice = { tone: "error" | "success" | "info"; message: string; durationMs?: number } | null;
type LoadingPreview = {
  loading: true;
  nodeId: string;
  filename: string;
  canDownload: boolean;
  isDrivePreview?: boolean;
  openInGoogleUrl?: string | null;
  canEditInGoogle?: boolean;
};
type AvailablePreview = PreviewSession & { canDownload: boolean; isDrivePreview?: boolean; openInGoogleUrl?: string | null; canEditInGoogle?: boolean };
type UnavailablePreview = {
  unavailable: true;
  nodeId: string;
  filename: string;
  canDownload: boolean;
  contentUrl?: string;
  engine?: PreviewSession["engine"];
  capabilities?: PreviewSession["capabilities"];
  preview?: FilePreviewDescriptor;
  isDrivePreview?: boolean;
  openInGoogleUrl?: string | null;
  canEditInGoogle?: boolean;
};
type Preview = LoadingPreview | AvailablePreview | UnavailablePreview;

function previewIsUnavailable(preview: Preview): preview is UnavailablePreview {
  return "unavailable" in preview;
}
function previewIsLoading(preview: Preview): preview is LoadingPreview {
  return "loading" in preview;
}

function currentFolderId() {
  return (
    window.location.pathname.match(/^\/drive\/([0-9a-f-]+)$/i)?.[1] ?? null
  );
}
type DriveSort = { by: NodeSortBy; direction: NodeSortDirection };
type ViewMode = "list" | "grid";
const defaultDriveSort: DriveSort = { by: "name", direction: "asc" };
const SIDEBAR_WIDTH_STORAGE_KEY = "dochub.sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 216;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 440;

function sidebarWidthBounds() {
  const viewportMaximum = window.innerWidth - 280;
  return {
    min: MIN_SIDEBAR_WIDTH,
    max: Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, viewportMaximum)),
  };
}

function clampSidebarWidth(width: number) {
  const { min, max } = sidebarWidthBounds();
  return Math.min(max, Math.max(min, width));
}

function readSidebarWidth() {
  try {
    const value = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (value === null) return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    const width = Number(value);
    return Number.isFinite(width)
      ? clampSidebarWidth(width)
      : clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  } catch {
    return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  }
}

function persistSidebarWidth(width: number) {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Sidebar width is a local preference and must not interrupt browsing.
  }
}

function readViewMode(key: string): ViewMode {
  try {
    return window.localStorage.getItem(key) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

function persistViewMode(key: string, value: ViewMode) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // View preference is optional and should not interrupt browsing.
  }
}

function currentDriveSort(): DriveSort {
  const parameters = new URLSearchParams(window.location.search);
  const by = parameters.get("sortBy");
  const direction = parameters.get("sortDirection");
  if (by !== "name" && by !== "lastModified") return defaultDriveSort;
  if (direction !== "asc" && direction !== "desc") {
    return by === "lastModified"
      ? { by, direction: "desc" }
      : defaultDriveSort;
  }
  return { by, direction };
}

function drivePath(folderId: string | null, sort: DriveSort) {
  const parameters = new URLSearchParams();
  if (
    sort.by !== defaultDriveSort.by ||
    sort.direction !== defaultDriveSort.direction
  ) {
    parameters.set("sortBy", sort.by);
    parameters.set("sortDirection", sort.direction);
  }
  const pathname = folderId ? `/drive/${folderId}` : "/drive";
  return parameters.size ? `${pathname}?${parameters}` : pathname;
}

function nextDriveSort(sort: DriveSort, by: NodeSortBy): DriveSort {
  if (sort.by === by) {
    return { by, direction: sort.direction === "asc" ? "desc" : "asc" };
  }
  return { by, direction: by === "lastModified" ? "desc" : "asc" };
}
function currentRoute() {
  if (/^\/document\/[0-9a-f-]+$/i.test(window.location.pathname)) return "legacyDocument";
  if (/^\/s\//.test(window.location.pathname)) return "legacyShare";
  if (window.location.pathname === "/admin") return "admin";
  if (window.location.pathname === "/profile") return "profile";
  if (window.location.pathname === "/trash") return "trash";
  if (window.location.pathname === "/search") return "search";
  if (window.location.pathname === "/recent") return "recent";
  if (window.location.pathname === "/favorites") return "favorites";
  return "drive";
}
function currentLocation() {
  return {
    route: currentRoute(),
    searchQuery: currentSearchQuery(),
    adminTab: currentAdminTab(),
  };
}
function pageTitleFor(
  location: ReturnType<typeof currentLocation>,
  authenticated: boolean | null,
) {
  let title: string;
  if (window.location.pathname === "/auth/pending") {
    title = t("auth.pendingApproval");
  } else if (authenticated === null) {
    title = t("auth.checkingSession");
  } else if (!authenticated) {
    title = t("auth.signIn");
  } else {
    switch (location.route) {
      case "admin": {
        const section = location.adminTab === "drive"
          ? t("admin.drive")
          : location.adminTab === "groups"
            ? t("admin.groups")
            : t("admin.users");
        title = `${t("admin.title")} · ${section}`;
        break;
      }
      case "profile":
        title = t("profile.title");
        break;
      case "trash":
        title = t("trash.title");
        break;
      case "search":
        title = t("search.title");
        break;
      case "recent":
        title = t("nav.recent");
        break;
      case "favorites":
        title = t("nav.favorites");
        break;
      case "legacyDocument":
        title = t("document.accessDeniedTitle");
        break;
      case "legacyShare":
        title = t("document.linkUnavailable");
        break;
      default:
        title = t("files.title");
        break;
    }
  }
  return t("meta.pageTitle", { title });
}
function currentAdminTab(): "users" | "groups" | "drive" {
  const tab = new URLSearchParams(window.location.search).get("tab");
  return tab === "groups" || tab === "drive" ? tab : "users";
}
function navigateAdmin(tab: "users" | "groups" | "drive" = "users") {
  const path = `/admin${tab === "users" ? "" : `?tab=${tab}`}`;
  if (`${window.location.pathname}${window.location.search}` !== path) {
    if (!confirmEditorNavigation()) return;
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
function navigateProfile() {
  if (window.location.pathname !== "/profile") {
    if (!confirmEditorNavigation()) return;
    window.history.pushState({}, "", "/profile");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
function currentSearchQuery() {
  return new URLSearchParams(window.location.search).get("q") ?? "";
}
function navigate(folderId: string | null) {
  const path = drivePath(folderId, currentDriveSort());
  if (`${window.location.pathname}${window.location.search}` !== path) {
    if (!confirmEditorNavigation()) return;
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
function navigateTrash() {
  if (window.location.pathname !== "/trash") {
    if (!confirmEditorNavigation()) return;
    window.history.pushState({}, "", "/trash");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
function navigateCollection(route: "recent" | "favorites") {
  const path = `/${route}`;
  if (window.location.pathname !== path) {
    if (!confirmEditorNavigation()) return;
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
function navigateSearch(query: string) {
  const parameters = new URLSearchParams();
  if (query) parameters.set("q", query);
  const path = `/search${parameters.size ? `?${parameters}` : ""}`;
  if (`${window.location.pathname}${window.location.search}` !== path) {
    if (!confirmEditorNavigation()) return;
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
function displayError(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : t("errors.generic");
}
function hasCapability(node: Node, capability: string) {
  return node.capabilities.includes(capability);
}
function canOpenNode(node: Node) {
  return node.type === "FOLDER" ||
    hasCapability(node, "PREVIEW") ||
    hasCapability(node, "DOWNLOAD");
}
function openActionLabel(node: Node) {
  if (node.type === "FOLDER") return t("files.openFolder");
  return hasCapability(node, "PREVIEW") ? t("files.preview") : t("common.download");
}
async function openFileActivation(
  node: Node,
  setPreview: (preview: Preview) => void,
  onError: (notice: Notice) => void,
) {
  try {
    setPreview({
      loading: true,
      nodeId: node.id,
      filename: node.name,
      canDownload: hasCapability(node, "DOWNLOAD"),
    });
    try {
      await api.recordRecent(node.id);
    } catch {
      // Recent is best-effort; it must not prevent opening the document.
    }
    const session = await api.createFilePreviewSession(node.id);
    const canDownload = hasCapability(node, "DOWNLOAD") && (session?.capabilities?.download ?? true);
    if (!session || session.previewable === false || session.preview?.kind === "unavailable") {
      setPreview({
        unavailable: true,
        nodeId: node.id,
        filename: node.name,
        canDownload,
        contentUrl: session?.contentUrl,
        engine: session?.engine,
        capabilities: session?.capabilities,
        preview: session?.preview,
      });
      return;
    }
    setPreview({ ...session, canDownload });
  } catch (error) {
    onError({ tone: "error", message: displayError(error) });
  }
}

function downloadPreview(preview: Preview) {
  if (previewIsLoading(preview)) return Promise.resolve();
  if (!previewIsUnavailable(preview)
    && preview.engine
    && ["DOCUMENT", "SPREADSHEET", "PRESENTATION"].includes(preview.engine)
    && preview.preview?.kind === "pdf") {
    // Office/PDF fallback content is a rendered preview; downloads must use
    // the original authorized node stream instead.
    return api.downloadNode(preview.nodeId, preview.filename);
  }
  if (preview.contentUrl) return api.downloadPreview(preview.contentUrl, preview.filename);
  return api.downloadNode(preview.nodeId, preview.filename);
}

function openDriveInGoogle(node: Node) {
  if (node.backing?.type === "GOOGLE_DRIVE" && node.backing.webViewLink) {
    window.open(node.backing.webViewLink, "_blank", "noopener,noreferrer");
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
function formatVersionTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(
    getLocale() === "vi" ? "vi-VN" : "en-US",
    { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" },
  ).format(date);
}
function formatLastModified(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  const now = new Date();
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  const relative = new Intl.RelativeTimeFormat(
    getLocale() === "vi" ? "vi-VN" : "en-US",
    { numeric: "always" },
  );
  if (minutes >= 0 && minutes < 60) return relative.format(-minutes, "minute");
  if (minutes >= 60 && minutes < 24 * 60)
    return relative.format(-Math.floor(minutes / 60), "hour");
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const daysAgo = Math.floor((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000);
  if (daysAgo === 1) {
    const time = new Intl.DateTimeFormat(getLocale() === "vi" ? "vi-VN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
    return t("dates.yesterdayAt", { time });
  }
  return new Intl.DateTimeFormat(
    getLocale() === "vi" ? "vi-VN" : "en-US",
    { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" },
  ).format(date);
}
function actorLabel(actor: FileVersion["actor"]) {
  if (actor.displayName?.trim()) return actor.displayName;
  return t(`actors.${actor.type}`);
}
function formatBytes(value: string | null) {
  if (value === null) return "—";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const locale = getLocale() === "vi" ? "vi-VN" : "en-US";
  const number = (amount: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(amount);
  if (bytes < 1024) return `${number(bytes)} ${t("files.units.bytes")}`;
  if (bytes < 1024 * 1024) return `${number(bytes / 1024)} ${t("files.units.kilobytes")}`;
  return `${number(bytes / (1024 * 1024))} ${t("files.units.megabytes")}`;
}
function formatVersionSource(source: FileVersion["source"] | FileRevisionHistoryItem["source"]) {
  return t(`versions.sources.${source}`);
}
function systemRoleLabel(role: SystemRole) {
  return t(`roles.${role}`);
}
function userStatusLabel(status: string) {
  return t(`statuses.${status}`, { defaultValue: status });
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
    back: <path d="m14.5 5-7 7 7 7M8 12h12" />,
    list: (
      <>
        <path d="M5 6h.01M9 6h10M5 12h.01M9 12h10M5 18h.01M9 18h10" strokeWidth="2.2" strokeLinecap="round" />
      </>
    ),
    grid: (
      <>
        <rect x="4" y="4" width="6" height="6" rx="1" />
        <rect x="14" y="4" width="6" height="6" rx="1" />
        <rect x="4" y="14" width="6" height="6" rx="1" />
        <rect x="14" y="14" width="6" height="6" rx="1" />
      </>
    ),
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
    if (notice.durationMs === 0) return;
    const timer = window.setTimeout(onDismiss, notice.durationMs ?? 3200);
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

export function UploadPicker({
  inputRef,
  disabled,
  onChange,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  disabled: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      ref={inputRef}
      className="visually-hidden"
      type="file"
      multiple
      onChange={onChange}
      disabled={disabled}
    />
  );
}

function App() {
  const { i18n } = useTranslation();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [profile, setProfile] = useState<CurrentUser | null>(null);
  const [location, setLocation] = useState(currentLocation);
  const [createOpen, setCreateOpen] = useState(false);
  const [driveImportOpen, setDriveImportOpen] = useState(false);
  const [folderCreationParentId, setFolderCreationParentId] = useState<string | null>(null);
  const [uploadingFromMenu, setUploadingFromMenu] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [creationNotice, setCreationNotice] = useState<Notice>(null);
  const [sidebarPreview, setSidebarPreview] = useState<Preview | null>(null);
  const sidebarPreviewActivation = useRef(0);
  const menuUploadInput = useRef<HTMLInputElement>(null);
  const creationParentId = location.route === "drive" ? currentFolderId() : null;
  const [folderCreateCapability, setFolderCreateCapability] = useState<{ folderId: string; canCreate: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    if (window.location.pathname === "/auth/pending") {
      return () => {
        active = false;
      };
    }
    void api.refresh().then(
      () => api.currentUser(),
    ).then(
      (user) => {
        if (!active) return;
        if (
          !/^(?:\/drive(?:\/[0-9a-f-]+)?|\/trash|\/search|\/recent|\/favorites|\/admin|\/profile|\/document\/[0-9a-f-]+|\/s\/[^/]+)$/i.test(
            window.location.pathname,
          )
        ) window.history.replaceState({}, "", "/drive");
        setLocation(currentLocation());
        setProfile(user);
        setRecoveryUser(user.id);
        setAuthenticated(true);
      },
      () => active && setAuthenticated(false),
    );
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const onPopState = () => setLocation(currentLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    let active = true;
    if (
      !authenticated ||
      !profile ||
      profile.status !== "ACTIVE" ||
      location.route !== "drive" ||
      creationParentId === null
    ) {
      return () => {
        active = false;
      };
    }

    void api.getNode(creationParentId).then(
      (node) => {
        if (active) setFolderCreateCapability({ folderId: creationParentId, canCreate: node.capabilities.includes("CREATE") });
      },
      () => {
        // Keep the UI conservative when the folder capability cannot be read.
        if (active) setFolderCreateCapability({ folderId: creationParentId, canCreate: false });
      },
    );
    return () => {
      active = false;
    };
  }, [authenticated, creationParentId, location.route, profile]);
  useEffect(() => {
    document.title = pageTitleFor(location, authenticated);
  }, [authenticated, i18n.language, location]);
  if (window.location.pathname === "/auth/pending") return <PendingApproval />;
  if (authenticated === null)
    return <div className="auth-state">{t("auth.checkingSession")}</div>;
  if (location.route === "legacyShare")
    return (
      <DocumentAccessState kind="unavailable" />
    );
  if (location.route === "legacyDocument")
    return <DocumentAccessState kind="unavailable" />;
  if (!authenticated) return <SignIn />;
  if (!profile) return <div className="auth-state">{t("auth.loadingAccount")}</div>;
  const isAdmin = profile.status === "ACTIVE" && canAdministerAccounts(profile.systemRole);
  const canManage = profile.status === "ACTIVE" && canManageDocuments(profile.systemRole);
  const canCreate = canManage && (
    location.route !== "drive" ||
    creationParentId === null ||
    (folderCreateCapability?.folderId === creationParentId && folderCreateCapability.canCreate)
  );
  function beginCreateFolder() {
    setFolderCreationParentId(creationParentId);
    setCreateOpen(true);
  }
  async function createFolder(name: string) {
    const node = await api.createFolder(name, folderCreationParentId);
    window.dispatchEvent(new CustomEvent("nodes-changed", { detail: { parentId: folderCreationParentId } }));
    setCreationNotice({ tone: "success", message: t("files.created", { name: node.name }) });
  }
  async function runUploadItems(items: UploadQueueItem[]) {
    if (!items.length) return;
    setUploadingFromMenu(true);
    try {
      await runUploadQueue(
        items,
        (item) => api.upload(
          item.file,
          item.destinationFolderId,
          item.idempotencyKey,
          (progress) => {
            setUploadQueue((current) => current.map((entry) => (
              entry.id === item.id && entry.progress !== progress
                ? { ...entry, progress }
                : entry
            )));
          },
        ),
        (id, update) => {
          setUploadQueue((current) => current.map((item) => item.id === id ? { ...item, ...update } : item));
        },
        {
          concurrency: 3,
          isAuthorizationError: (error) => error instanceof ApiError && (error.status === 401 || error.status === 403),
          getErrorMessage: displayError,
          authorizationMessage: t("files.uploadAuthorizationFailed"),
        },
      );
    } finally {
      setUploadingFromMenu(false);
      window.dispatchEvent(new CustomEvent("nodes-changed", {
        detail: { parentId: items[0]?.destinationFolderId ?? null },
      }));
    }
  }
  function beginUpload(files: readonly File[], destinationFolderId: string | null) {
    if (!files.length || uploadingFromMenu) return;
    setCreationNotice(null);
    const items = createUploadQueueItems(files, destinationFolderId);
    setUploadQueue(items);
    void runUploadItems(items);
  }
  function uploadFromMenu(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length) return;
    beginUpload(files, currentFolderId());
  }
  function retryFailedUploads() {
    if (uploadingFromMenu) return;
    const failed = uploadQueue.filter((item) => item.status === "failed");
    if (!failed.length) return;
    const retryItems = failed.map((item) => ({ ...item, idempotencyKey: crypto.randomUUID(), status: "queued" as const, progress: 0, error: null }));
    setUploadQueue((current) => current.map((item) => retryItems.some((retry) => retry.id === item.id) ? { ...item, status: "queued", progress: 0, error: null } : item));
    void runUploadItems(retryItems);
  }
  function retryUploadItem(id: string) {
    if (uploadingFromMenu) return;
    const failed = uploadQueue.find((item) => item.id === id && item.status === "failed");
    if (!failed) return;
    const retryItem = { ...failed, idempotencyKey: crypto.randomUUID(), status: "queued" as const, progress: 0, error: null };
    setUploadQueue((current) => current.map((item) => item.id === id ? retryItem : item));
    void runUploadItems([retryItem]);
  }
  function openUploadPicker() {
    if (!uploadingFromMenu) menuUploadInput.current?.click();
  }
  async function openSidebarFile(item: NodeTreeItem) {
    const activation = ++sidebarPreviewActivation.current;
    try {
      const node = await api.getNode(item.id);
      if (activation !== sidebarPreviewActivation.current) return;
      await openFileActivation(
        node,
        (nextPreview) => {
          if (activation === sidebarPreviewActivation.current) {
            setSidebarPreview(nextPreview);
          }
        },
        (notice) => {
          if (activation === sidebarPreviewActivation.current) {
            setCreationNotice(notice);
          }
        },
      );
    } catch (error) {
      if (activation === sidebarPreviewActivation.current) {
        setCreationNotice({ tone: "error", message: displayError(error) });
      }
    }
  }
  function closeSidebarPreview() {
    sidebarPreviewActivation.current += 1;
    setSidebarPreview(null);
  }
  async function signOut() {
    const userId = profile?.id;
    try {
      await api.logout();
    } finally {
      if (userId) await clearRecoveryDraftsForUser(userId);
      clearRecoveryUser();
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
      page = <DriveApp canCreate={canCreate} canManageDocuments={canManage} uploading={uploadingFromMenu} onCreateFolder={beginCreateFolder} onUpload={openUploadPicker} />;
  }
  const active: SidebarRoute = location.route === "drive" || location.route === "recent" || location.route === "favorites" || location.route === "trash"
    ? location.route
    : location.route === "admin" && isAdmin ? "admin" : null;
  return (
    <>
      <AppShell
        profile={profile}
        active={active}
        canManageDocuments={canManage}
        canCreate={canCreate}
        uploadingFromMenu={uploadingFromMenu}
        activeFolderId={location.route === "drive" ? creationParentId : null}
        onOpenDriveImport={() => setDriveImportOpen(true)}
        onUpload={openUploadPicker}
        onCreateFolder={beginCreateFolder}
        onOpenFile={openSidebarFile}
        onSignOut={() => void signOut()}
      >
        {page}
      </AppShell>
      {sidebarPreview && (
        <PreviewDialog
          key={previewIsUnavailable(sidebarPreview) ? `unavailable-${sidebarPreview.nodeId}` : previewIsLoading(sidebarPreview) ? `loading-${sidebarPreview.nodeId}` : sidebarPreview.sessionId}
          preview={sidebarPreview}
          onClose={closeSidebarPreview}
          onDownload={() => downloadPreview(sidebarPreview)}
        />
      )}
      <UploadPicker
        inputRef={menuUploadInput}
        onChange={(event) => void uploadFromMenu(event)}
        disabled={uploadingFromMenu}
      />
      {driveImportOpen && (
        <GoogleDriveModal
          canManageDocuments={canManage}
          onClose={() => setDriveImportOpen(false)}
        />
      )}
      <Toast notice={creationNotice} onDismiss={() => setCreationNotice(null)} />
      {createOpen && (
        <NameDialog
          title={t("files.newFolder")}
          action={t("common.create")}
          onClose={() => setCreateOpen(false)}
          onSubmit={createFolder}
        />
      )}
      {uploadQueue.length > 0 && (
        <UploadQueuePanel
          items={uploadQueue}
          active={uploadingFromMenu}
          onRetryItem={retryUploadItem}
          onRetryFailed={retryFailedUploads}
          onClear={() => setUploadQueue([])}
        />
      )}
    </>
  );
}
function UploadQueuePanel({
  items,
  active,
  onRetryItem,
  onRetryFailed,
  onClear,
}: {
  items: UploadQueueItem[];
  active: boolean;
  onRetryItem: (id: string) => void;
  onRetryFailed: () => void;
  onClear: () => void;
}) {
  const uploaded = items.filter((item) => item.status === "success").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const uploading = items.filter((item) => item.status === "uploading").length;
  const queued = items.filter((item) => item.status === "queued").length;
  const totalBytes = items.reduce((total, item) => total + item.file.size, 0);
  const uploadedBytes = items.reduce((total, item) => total + (item.file.size * item.progress) / 100, 0);
  const progress = totalBytes > 0
    ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100))
    : items.length > 0
      ? Math.round(((uploaded + failed) / items.length) * 100)
      : 0;
  const statusLabel = (item: UploadQueueItem) => {
    if (item.status === "queued") return t("files.uploadQueueQueued");
    if (item.status === "uploading") return t("files.uploadQueueUploading");
    if (item.status === "success") return t("files.uploadQueueSuccess");
    return item.error ? t("files.uploadQueueFailedWithReason", { error: item.error }) : t("files.uploadQueueFailed");
  };
  return (
    <section className="upload-queue-panel" aria-label={t("files.uploadQueueTitle")} aria-live="polite">
      <header className="upload-queue-header">
        <div>
          <h2>{t("files.uploadQueueTitle")}</h2>
          <p>
            {active
              ? t("files.uploadQueueProgress", { completed: uploaded + failed, total: items.length, uploading, queued })
              : t("files.uploadQueueSummary", { uploaded, failed })}
          </p>
        </div>
        <button type="button" className="icon-button" onClick={onClear} disabled={active} aria-label={t("files.uploadQueueDismiss")}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="upload-queue-progress">
        <div
          className="upload-queue-progress-track"
          role="progressbar"
          aria-label={t("files.uploadQueueTitle")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-valuetext={t("files.uploadQueuePercent", { percent: progress })}
        >
          <span className="upload-queue-progress-bar" style={{ width: `${progress}%` }} />
        </div>
        <span className="upload-queue-progress-value">{t("files.uploadQueuePercent", { percent: progress })}</span>
      </div>
      <ul className="upload-queue-list">
        {items.map((item) => (
          <li key={item.id} className={`upload-queue-item is-${item.status}`}>
            <span className="upload-queue-name" title={item.file.name}>{item.file.name}</span>
            <span className="upload-queue-status">{statusLabel(item)}</span>
            {!active && item.status === "failed" && (
              <button type="button" className="upload-queue-retry" onClick={() => onRetryItem(item.id)}>
                {t("files.uploadQueueRetry")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {!active && (
        <footer className="upload-queue-actions">
          <button type="button" className="button" onClick={onRetryFailed} disabled={failed === 0}>
            {t("files.uploadQueueRetryFailed")}
          </button>
          <button type="button" className="button button-primary" onClick={onClear}>
            {t("files.uploadQueueDismiss")}
          </button>
        </footer>
      )}
    </section>
  );
}
function AccessDenied() {
  return <div className="content-state"><h1>{t("admin.accessDenied")}</h1><p>{t("admin.askAdministrator")}</p></div>;
}

function AdminApp({ tab }: { tab: "users" | "groups" | "drive" }) {
  return <><PageHeader /><section className="admin-content" aria-label={t("admin.title")}>
    <div className="admin-intro"><h2>{t("admin.title")}</h2><p>{t("admin.description")}</p></div>
    <div className="admin-tabs" role="tablist" aria-label={t("admin.sections")}>
      <button type="button" role="tab" aria-selected={tab === "users"} className={tab === "users" ? "is-active" : ""} onClick={() => navigateAdmin("users")}>{t("admin.users")}</button>
      <button type="button" role="tab" aria-selected={tab === "groups"} className={tab === "groups" ? "is-active" : ""} onClick={() => navigateAdmin("groups")}>{t("admin.groups")}</button>
      <button type="button" role="tab" aria-selected={tab === "drive"} className={tab === "drive" ? "is-active" : ""} onClick={() => navigateAdmin("drive")}>{t("admin.drive")}</button>
    </div>
    <div className="admin-tab-content">{tab === "users" ? <AdminUsers /> : tab === "groups" ? <AdminGroups /> : <AdminDriveIntegration />}</div>
  </section></>;
}

function AdminDriveIntegration() {
  const [connection, setConnection] = useState<DriveIntegration | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState("");
  const [selectedFolderName, setSelectedFolderName] = useState("");
  const [busy, setBusy] = useState<"load" | "connect" | "save" | "sync" | "disconnect" | null>("load");
  const [notice, setNotice] = useState<Notice>(null);
  const load = useCallback(async () => {
    try {
      const state = await api.driveIntegration();
      setConnection(state);
      setSelectedFolderId(state.storageFolderId ?? "");
      setSelectedFolderName(state.storageFolderName ?? state.storageFolderId ?? "");
    } catch (error) {
      setNotice({ tone: "error", message: displayError(error) });
    } finally {
      setBusy(null);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  async function connect() {
    setBusy("connect");
    try { await api.startDriveIntegration("WRITE"); } catch (error) { setBusy(null); setNotice({ tone: "error", message: displayError(error) }); }
  }
  async function save() {
    if (!selectedFolderId || selectedFolderId === connection?.storageFolderId) return;
    setBusy("save");
    try {
      const state = await api.configureCompanyStorageFolder(selectedFolderId);
      setConnection(state);
      setSelectedFolderId(state.storageFolderId ?? "");
      setSelectedFolderName(state.storageFolderName ?? state.storageFolderId ?? "");
      setNotice({ tone: "success", message: t("admin.driveSaved") });
    } catch (error) { setNotice({ tone: "error", message: displayError(error) }); } finally { setBusy(null); }
  }
  async function sync() {
    setBusy("sync");
    try { setConnection(await api.syncDrive()); setNotice({ tone: "success", message: t("drive.syncComplete") }); } catch (error) { setNotice({ tone: "error", message: displayError(error) }); } finally { setBusy(null); }
  }
  async function disconnect() {
    if (!window.confirm(t("drive.disconnectConfirm"))) return;
    setBusy("disconnect");
    try { setConnection(await api.disconnectDrive()); } catch (error) { setNotice({ tone: "error", message: displayError(error) }); } finally { setBusy(null); }
  }
  return <>
    <Toast notice={notice} onDismiss={() => setNotice(null)} />
    <div className="admin-section-header"><div><h3>{t("admin.drive")}</h3><p>{t("admin.driveDescription")}</p></div></div>
    <section className="integration-section" aria-label={t("admin.drive")}>
      {busy === "load" && !connection ? <p className="integration-state">{t("common.loading")}</p> : <>
        <dl className="profile-details">
          <div><dt>{t("drive.status")}</dt><dd>{connection?.connected ? connection.needsReauthorization ? t("drive.reauthorizationRequired") : t("drive.connected") : t("drive.notConnected")}</dd></div>
          <div><dt>{t("drive.access")}</dt><dd>{connection?.canRead ? t("drive.readEnabled") : connection?.connected ? t("drive.readAuthorizationRequired") : t("drive.notConfigured")}</dd></div>
          <div><dt>{t("drive.writeAccess")}</dt><dd>{connection?.canWrite ? t("drive.writeEnabled") : connection?.connected ? t("drive.writeAuthorizationRequired") : t("drive.notConfigured")}</dd></div>
          <div><dt>{t("drive.account")}</dt><dd>{connection?.googleEmail ?? t("drive.notConfigured")}</dd></div>
          <div><dt>{t("drive.lastSynced")}</dt><dd>{connection?.lastSyncCompletedAt ? formatDate(connection.lastSyncCompletedAt) : t("drive.neverSynced")}</dd></div>
        </dl>
        {connection?.connected && <div className="drive-storage-folder">
          <label htmlFor="drive-storage-folder-trigger">{t("drive.storageFolder")}</label>
          <div className="drive-storage-folder-row">
            <DriveFolderCombobox
              enabled={connection.canRead}
              disabled={!connection.canRead}
              selectedFolderId={selectedFolderId}
              selectedFolderName={selectedFolderName}
              onSelect={(folder) => {
                setSelectedFolderId(folder.id);
                setSelectedFolderName(folder.name);
              }}
            />
            <button type="button" className="button button-primary" disabled={busy !== null || !connection.canRead || !selectedFolderId || selectedFolderId === connection.storageFolderId} onClick={() => void save()}>{busy === "save" ? t("common.saving") : t("drive.useThisFolder")}</button>
          </div>
        </div>}
        <div className="integration-actions">
          {(!connection?.connected || connection.needsReauthorization) && <button type="button" className="button button-primary" disabled={busy !== null} onClick={() => void connect()}>{busy === "connect" ? t("drive.connecting") : connection?.connected ? t("drive.reauthorize") : t("drive.connectCompany")}</button>}
          {connection?.connected && <><button type="button" className="button button-primary" disabled={busy !== null || !connection.configured} onClick={() => void sync()}>{busy === "sync" ? t("drive.syncing") : t("drive.syncNow")}</button><button type="button" className="button button-danger" disabled={busy !== null} onClick={() => void disconnect()}>{busy === "disconnect" ? t("drive.disconnecting") : t("drive.disconnect")}</button></>}
        </div>
        {connection?.needsReauthorization && <p className="form-error">{t("drive.reauthorizationRequired")}</p>}
      </>}
    </section>
  </>;
}

function DriveFolderCombobox({
  enabled,
  disabled,
  selectedFolderId,
  selectedFolderName,
  onSelect,
}: {
  enabled: boolean;
  disabled: boolean;
  selectedFolderId: string;
  selectedFolderName: string;
  onSelect: (folder: DriveFolderOption) => void;
}) {
  const [folders, setFolders] = useState<DriveFolderOption[]>([]);
  const [query, setQuery] = useState("");
  const [searchRevision, setSearchRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const requestRevision = useRef(0);

  const loadFolders = useCallback(async (nameQuery: string) => {
    const revision = ++requestRevision.current;
    setLoading(true);
    setError("");
    try {
      const nextFolders = await api.listCompanyDriveFolders(nameQuery);
      if (revision !== requestRevision.current) return;
      setFolders(nextFolders);
    } catch (requestError) {
      if (revision !== requestRevision.current) return;
      setError(displayError(requestError));
    } finally {
      if (revision === requestRevision.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      requestRevision.current += 1;
      return;
    }
    const timer = window.setTimeout(() => { void loadFolders(""); }, 0);
    return () => window.clearTimeout(timer);
  }, [enabled, loadFolders]);

  useEffect(() => {
    if (!enabled || searchRevision === 0) return;
    const timer = window.setTimeout(() => { void loadFolders(query); }, 300);
    return () => window.clearTimeout(timer);
  }, [enabled, loadFolders, query, searchRevision]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const closePicker = useCallback(() => {
    requestRevision.current += 1;
    setOpen(false);
    setQuery("");
    setSearchRevision(0);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!open || !enabled) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as globalThis.Node)) closePicker();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [closePicker, enabled, open]);

  const visibleFolders = query.trim()
    ? folders.filter((folder) => folder.name.toLowerCase().includes(query.trim().toLowerCase()))
    : folders;
  const selectedName = selectedFolderName || t("drive.chooseStorageFolder");
  const isOpen = open && enabled;

  function openPicker() {
    if (disabled) return;
    setQuery("");
    setSearchRevision(0);
    setError("");
    setOpen(true);
  }

  return <div ref={root} className="drive-folder-combobox">
    {isOpen ? <div className="search-field drive-folder-combobox-input">
      <Icon name="search" size={17} />
      <input
        id="drive-storage-folder-trigger"
        ref={input}
        role="combobox"
        aria-controls="drive-storage-folder-options"
        aria-expanded="true"
        aria-autocomplete="list"
        value={query}
        onChange={(event) => {
          requestRevision.current += 1;
          setLoading(true);
          setError("");
          setQuery(event.target.value);
          setSearchRevision((value) => value + 1);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            closePicker();
          }
        }}
        placeholder={t("drive.chooseStorageFolder")}
        aria-label={t("drive.storageFolder")}
        disabled={disabled}
      />
    </div> : <button
      id="drive-storage-folder-trigger"
      type="button"
      className="search-field drive-folder-combobox-trigger"
      aria-haspopup="listbox"
      aria-controls="drive-storage-folder-options"
      aria-expanded="false"
      aria-label={t("drive.storageFolder")}
      onClick={openPicker}
      disabled={disabled}
    >
      <Icon name="search" size={17} />
      <span className={selectedFolderName ? "drive-folder-combobox-value" : "drive-folder-combobox-value is-placeholder"}>{selectedName}</span>
      <Icon name="chevron-down" size={15} />
    </button>}
    {isOpen && <div id="drive-storage-folder-options" className="drive-folder-combobox-dropdown" role="listbox" aria-label={t("drive.storageFolder")}>
      {loading && <p className="drive-folder-combobox-status">{t("drive.loadingFolders")}</p>}
      {error && <p className="drive-folder-combobox-status drive-folder-combobox-error" role="alert">{error}</p>}
      {!loading && visibleFolders.length === 0 && <p className="drive-folder-combobox-status">{t("drive.noFoldersFound")}</p>}
      {visibleFolders.map((folder) => <button
        key={folder.id}
        type="button"
        role="option"
        aria-selected={folder.id === selectedFolderId}
        className={`drive-folder-combobox-option${folder.id === selectedFolderId ? " is-selected" : ""}`}
        onClick={() => {
          onSelect(folder);
          closePicker();
        }}
      >
        <Icon name="folder" size={17} />
        <span>{folder.name}</span>
      </button>)}
    </div>}
  </div>;
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
  async function action(user: AdminUser, kind: "approve" | "role" | "status", nextRole?: SystemRole) {
    if (kind === "status" && user.status !== "SUSPENDED" && !window.confirm(t("admin.suspendConfirm", { name: user.displayName }))) return;
    setOpenMenuId(null);
    try {
      const updated = kind === "approve"
        ? await api.approveAdminUser(user.id)
        : kind === "role"
          ? await api.updateAdminUser(user.id, { systemRole: nextRole ?? user.systemRole })
          : user.status === "SUSPENDED"
            ? await api.reactivateAdminUser(user.id)
            : await api.suspendAdminUser(user.id);
      setUsers((items) => items.map((item) => item.id === user.id ? updated : item));
      if (kind === "approve") setNotice({ tone: "success", message: t("admin.accountApproved") });
    } catch (error) { setNotice({ tone: "error", message: displayError(error) }); }
  }
  const matching = users.filter((user) => `${user.displayName} ${user.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <Toast notice={notice} onDismiss={() => setNotice(null)} />
    <div className="admin-section-header"><div><h3>{t("admin.users")}</h3><p>{t("admin.usersDescription")}</p></div><button type="button" className="button button-primary" onClick={() => setAddOpen(true)}><Icon name="plus" size={16} />{t("admin.addUser")}</button></div>
    <div className="search-field search-field-admin"><Icon name="search" size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("admin.searchUsers")} aria-label={t("admin.searchUsers")} /></div>
    <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t("common.name")}</th><th>{t("common.email")}</th><th>{t("common.role")}</th><th>{t("common.status")}</th><th>{t("common.actions")}</th></tr></thead><tbody>{matching.map((user) => <AdminUserRow key={user.id} user={user} menuOpen={openMenuId === user.id} onToggleMenu={() => setOpenMenuId((open) => open === user.id ? null : user.id)} onCloseMenu={() => setOpenMenuId(null)} onAction={(kind, nextRole) => void action(user, kind, nextRole)} />)}</tbody></table></div>
    {addOpen && <AddUserDialog onClose={() => setAddOpen(false)} onSubmit={create} />}
  </>;
}

function AdminUserRow({ user, menuOpen, onToggleMenu, onCloseMenu, onAction }: { user: AdminUser; menuOpen: boolean; onToggleMenu: () => void; onCloseMenu: () => void; onAction: (kind: "approve" | "role" | "status", nextRole?: SystemRole) => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <tr><td>{user.displayName}</td><td>{user.email}</td><td>{systemRoleLabel(user.systemRole)}</td><td>{userStatusLabel(user.status)}</td><td className="row-actions">
    <button ref={trigger} type="button" className="icon-button" aria-label={t("admin.actionsFor", { name: user.displayName })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={onToggleMenu}><Icon name="more" /></button>
    {menuOpen && <RowMenu id={`admin-user-menu-${user.id}`} trigger={trigger} onClose={onCloseMenu}>
      {user.status === "PENDING_APPROVAL" ? (
        <button type="button" role="menuitem" onClick={() => { onCloseMenu(); onAction("approve"); }}>{t("admin.approve")}</button>
      ) : <>
        {(["ADMIN", "DOCUMENT_MANAGER", "VIEWER"] as SystemRole[]).map((role) => <button key={role} type="button" role="menuitem" disabled={role === user.systemRole} onClick={() => { onCloseMenu(); onAction("role", role); }}>{t("admin.setRole", { role: systemRoleLabel(role) })}</button>)}
        <div className="row-menu-divider" />
        <button type="button" role="menuitem" className={user.status === "SUSPENDED" ? "" : "menu-danger"} onClick={() => { onCloseMenu(); onAction("status"); }}>{user.status === "SUSPENDED" ? t("admin.reactivate") : t("admin.suspend")}</button>
      </>}
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
    const systemRole = String(form.get("systemRole") ?? "VIEWER") as SystemRole;
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
      <label htmlFor="add-user-role">{t("common.role")}</label><select id="add-user-role" name="systemRole" defaultValue="VIEWER" required><option value="VIEWER">{t("roles.VIEWER")}</option><option value="DOCUMENT_MANAGER">{t("roles.DOCUMENT_MANAGER")}</option><option value="ADMIN">{t("roles.ADMIN")}</option></select>
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
  return <><Toast notice={notice} onDismiss={() => setNotice(null)} /><div className="admin-section-header"><div><h3>{t("admin.groups")}</h3><p>{t("admin.groupsDescription")}</p></div><form className="admin-inline-form" onSubmit={create}><input required name="name" placeholder={t("admin.newGroupName")} maxLength={200} aria-label={t("admin.newGroupName")} /><button className="button button-primary">{t("admin.newGroup")}</button></form></div><div className="search-field search-field-admin"><Icon name="search" size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("admin.searchGroups")} aria-label={t("admin.searchGroups")} /></div>{groups.length === 0 || matching.length === 0 ? <div className="admin-empty"><h3>{groups.length === 0 ? t("admin.noGroupsYet") : t("admin.noGroupsFound")}</h3><p>{groups.length === 0 ? t("admin.createGroupHint") : t("admin.tryDifferentSearch")}</p></div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t("admin.groupName")}</th><th>{t("common.members")}</th><th>{t("common.actions")}</th></tr></thead><tbody>{matching.map((group) => <><tr key={group.id}><td>{group.name}</td><td>{new Intl.NumberFormat(getLocale() === "vi" ? "vi-VN" : "en-US").format(group.memberCount)}</td><td><button className="button" onClick={() => void rename(group)}>{t("admin.rename")}</button><button className="button" onClick={() => void toggleMembers(group)}>{members[group.id] ? t("admin.closeMembers") : t("admin.manageMembers")}</button></td></tr>{members[group.id] && <tr key={`${group.id}-members`}><td colSpan={3}><select defaultValue="" onChange={(event) => { if (event.target.value) void add(group.id, event.target.value); event.currentTarget.value = ""; }}><option value="">{t("admin.addUserToGroup")}</option>{users.filter((user) => !members[group.id].some((member) => member.id === user.id)).map((user) => <option key={user.id} value={user.id}>{user.displayName} — {user.email}</option>)}</select>{members[group.id].map((user) => <div className="admin-member" key={user.id}>{user.displayName} <button className="button" onClick={() => void remove(group.id, user.id)}>{t("common.remove")}</button></div>)}</td></tr>}</>)}</tbody></table></div>}
  </>;
}

function ProfileApp({ profile, onSignOut }: { profile: CurrentUser; onSignOut: () => void }) {
  return <>
    <PageHeader />
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

function driveTypeLabel(type: DriveFile["normalizedType"]) {
  return t(`drive.types.${type}`);
}

function driveSourceStatusLabel(status: "CONNECTED" | "STALE" | "UNAVAILABLE") {
  return status === "CONNECTED"
    ? ""
    : status === "STALE"
      ? t("drive.sourceStale")
      : t("drive.sourceUnavailable");
}

function GoogleDriveModal({
  canManageDocuments: canManage,
  onClose,
}: {
  canManageDocuments: boolean;
  onClose: () => void;
}) {
  const dialog = useDialogFocus();
  const [connection, setConnection] = useState<DriveIntegration | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folderStack, setFolderStack] = useState<Array<{ id: string; name: string }>>([]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>(() => readViewMode("dochub.drive-import-view"));
  const [loading, setLoading] = useState(true);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [error, setError] = useState<Notice>(null);
  const [pickerFile, setPickerFile] = useState<DriveFile | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const requestRevision = useRef(0);
  const loadController = useRef<AbortController | null>(null);

  const load = useCallback(async (nextCursor?: string) => {
    if (!folderId) return;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const revision = ++requestRevision.current;
    setLoading(true);
    try {
      const page = await api.listDriveBrowserFiles(folderId, query, nextCursor, 50, controller.signal);
      if (revision !== requestRevision.current || controller.signal.aborted) return;
      setFiles((current) => nextCursor ? [...current, ...page.items] : page.items);
      setCursor(page.nextCursor);
      setError(null);
    } catch (requestError) {
      if (revision !== requestRevision.current || controller.signal.aborted) return;
      setError({ tone: "error", message: displayError(requestError) });
    } finally {
      if (revision === requestRevision.current) setLoading(false);
    }
  }, [folderId, query]);

  useEffect(() => {
    void api.driveIntegration().then((state) => {
      setConnection(state);
      setFolderId(state.configured ? state.storageFolderId ?? null : null);
    }).catch((requestError) => {
      setError({ tone: "error", message: displayError(requestError) });
    }).finally(() => setConnectionLoading(false));
    return () => loadController.current?.abort();
  }, []);

  useEffect(() => {
    if (!connection?.configured || !folderId) return;
    const timer = window.setTimeout(() => void load(), 300);
    return () => window.clearTimeout(timer);
  }, [connection, folderId, load]);

  function changeView(next: ViewMode) {
    setView(next);
    persistViewMode("dochub.drive-import-view", next);
  }

  function enterFolder(file: DriveFile) {
    if (file.normalizedType !== "FOLDER" || !folderId) return;
    const currentName = folderStack.at(-1)?.name ?? connection?.storageFolderName ?? t("drive.storageFolder");
    setFolderStack((current) => [...current, { id: folderId, name: currentName }]);
    setFolderId(file.driveFileId);
    setQuery("");
    setCursor(null);
  }

  function goBack() {
    const previous = folderStack.at(-1);
    if (!previous) return;
    setFolderStack((current) => current.slice(0, -1));
    setFolderId(previous.id);
    setQuery("");
    setCursor(null);
  }

  async function addToDocsHub(file: DriveFile, parentId: string | null) {
    setAddingId(file.driveFileId);
    try {
      const result = await api.addDriveFileToDocsHub(file.driveFileId, parentId);
      setFiles((current) => current.map((item) => item.driveFileId === file.driveFileId
        ? { ...item, docsHubNodeId: result.nodeId }
        : item));
      setPickerFile(null);
      window.dispatchEvent(new CustomEvent("nodes-changed", { detail: { parentId } }));
      setError({ tone: "success", message: t("drive.addedToDocsHub", { name: result.name }) });
    } catch (requestError) {
      setError({ tone: "error", message: displayError(requestError) });
    } finally {
      setAddingId(null);
    }
  }

  const unavailable = !connectionLoading && (!connection?.connected || !connection.configured);
  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialog} className="dialog drive-import-dialog" role="dialog" aria-modal="true" aria-labelledby="drive-import-title">
        <header className="dialog-header">
          <h2 id="drive-import-title">{t("drive.addFromGoogleDrive")}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t("common.close")}><Icon name="close" size={16} /></button>
        </header>
        {error && <p className={`drive-import-notice drive-import-notice-${error.tone}`} role={error.tone === "error" ? "alert" : "status"}>{error.message}</p>}
        {connectionLoading ? <div className="drive-import-state">{t("common.loading")}</div> : unavailable ? <div className="drive-import-state"><h3>{t("drive.notConnected")}</h3><p>{t("drive.adminConfigures")}</p></div> : (
          <>
            <div className="drive-import-toolbar">
              <button type="button" className="button" onClick={goBack} disabled={folderStack.length === 0}><Icon name="back" size={16} />{t("common.back")}</button>
              <div className="search-field drive-import-search"><Icon name="search" size={17} /><input autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setCursor(null); }} placeholder={t("drive.searchPlaceholder")} aria-label={t("drive.searchPlaceholder")} /></div>
              <ViewToggle value={view} onChange={changeView} label={t("drive.viewMode")} />
            </div>
            <div className="drive-import-content" aria-busy={loading}>
              {loading && files.length === 0 ? <div className="drive-import-state">{t("common.loading")}</div> : files.length === 0 ? <div className="drive-import-state">{t("drive.noFiles")}</div> : view === "list" ? (
                <div className="file-table-wrap drive-import-table-wrap"><table className="file-table drive-import-table"><colgroup><col className="drive-import-col-name" /><col className="drive-import-col-type" /><col className="drive-import-col-modified" /><col className="drive-import-col-action" /></colgroup><thead><tr><th>{t("common.name")}</th><th>{t("common.type")}</th><th>{t("common.modified")}</th><th>{t("common.actions")}</th></tr></thead><tbody>{files.map((file) => <DriveBrowserRow key={file.id} file={file} canManage={canManage} adding={addingId === file.driveFileId} onFolder={enterFolder} onSelect={setPickerFile} />)}</tbody></table></div>
              ) : <div className="drive-browser-grid">{files.map((file) => <DriveBrowserCard key={file.id} file={file} canManage={canManage} adding={addingId === file.driveFileId} onFolder={enterFolder} onSelect={setPickerFile} />)}</div>}
              {cursor && <button type="button" className="button drive-load-more" onClick={() => void load(cursor)} disabled={loading}>{t("search.loadMore")}</button>}
            </div>
          </>
        )}
      </section>
      {pickerFile && <DocsHubFolderPicker file={pickerFile} onClose={() => setPickerFile(null)} onSelect={(parentId) => void addToDocsHub(pickerFile, parentId)} pending={addingId === pickerFile.driveFileId} />}
    </div>
  );
}

function DriveBrowserRow({
  file,
  canManage,
  adding,
  onFolder,
  onSelect,
}: {
  file: DriveFile;
  canManage: boolean;
  adding: boolean;
  onFolder: (file: DriveFile) => void;
  onSelect: (file: DriveFile) => void;
}) {
  const isFolder = file.normalizedType === "FOLDER";
  return <tr>
    <td><button type="button" className="file-name" disabled={!isFolder && (!canManage || Boolean(file.docsHubNodeId))} onClick={() => isFolder ? onFolder(file) : onSelect(file)}><Icon name={isFolder ? "folder" : "file"} size={19} /><span>{file.name}</span></button></td>
    <td>{driveTypeLabel(file.normalizedType)}</td>
    <td>{file.driveModifiedTime ? formatDate(file.driveModifiedTime) : "—"}</td>
    <td className="drive-external-actions">{isFolder ? "—" : file.docsHubNodeId ? <span className="drive-in-docshub">{t("drive.alreadyInDocsHub")}</span> : canManage ? <button type="button" className="button" disabled={adding} onClick={() => onSelect(file)}>{t("drive.addToDocsHub")}</button> : "—"}</td>
  </tr>;
}

function DriveBrowserCard({
  file,
  canManage,
  adding,
  onFolder,
  onSelect,
}: {
  file: DriveFile;
  canManage: boolean;
  adding: boolean;
  onFolder: (file: DriveFile) => void;
  onSelect: (file: DriveFile) => void;
}) {
  const isFolder = file.normalizedType === "FOLDER";
  return <article className="drive-browser-card">
    <button type="button" className="drive-browser-card-main" disabled={!isFolder && (!canManage || Boolean(file.docsHubNodeId))} onClick={() => isFolder ? onFolder(file) : onSelect(file)}><Icon name={isFolder ? "folder" : "file"} size={22} /><strong title={file.name}>{file.name}</strong><span>{driveTypeLabel(file.normalizedType)} · {file.driveModifiedTime ? formatDate(file.driveModifiedTime) : "—"}</span></button>
    {!isFolder && (file.docsHubNodeId ? <span className="drive-in-docshub">{t("drive.alreadyInDocsHub")}</span> : canManage ? <button type="button" className="button" disabled={adding} onClick={() => onSelect(file)}>{t("drive.addToDocsHub")}</button> : null)}
  </article>;
}

function DocsHubFolderPicker({
  file,
  onClose,
  onSelect,
  pending,
}: {
  file: DriveFile;
  onClose: () => void;
  onSelect: (parentId: string | null) => void;
  pending: boolean;
}) {
  const dialog = useDialogFocus();
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  return <div className="dialog-backdrop" role="presentation"><section ref={dialog} className="dialog drive-folder-picker" role="dialog" aria-modal="true" aria-labelledby="drive-folder-picker-title">
    <header className="dialog-header"><div><h2 id="drive-folder-picker-title">{t("drive.chooseDocsHubFolder")}</h2><p>{file.name}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label={t("common.close")}><Icon name="close" size={16} /></button></header>
    <div className="dialog-body drive-folder-picker-body"><DocsHubFolderTree selectedFolderId={selectedFolderId} onSelect={setSelectedFolderId} showRoot /></div>
    <footer className="dialog-actions"><button type="button" className="button" onClick={onClose} disabled={pending}>{t("common.cancel")}</button><button type="button" className="button button-primary" onClick={() => onSelect(selectedFolderId)} disabled={pending}>{pending ? t("drive.addingToDocsHub") : t("drive.addHere")}</button></footer>
  </section></div>;
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

function PendingApproval() {
  return (
    <main className="sign-in">
      <section>
        <Icon name="drive" size={30} />
        <h1>Docs Hub</h1>
        <h2>{t("auth.accessRequestSubmitted")}</h2>
        <p>{t("auth.googleAccountRegistered")}</p>
        <p role="status" aria-label={t("auth.awaitingAdministratorApproval")}>
          {t("auth.yourAccountWaitingForApproval")}
        </p>
        <p>{t("auth.trySignInAfterApproval")}</p>
        <a className="button button-primary" href={api.googleAuthUrl()}>
          {t("auth.signInAgain")}
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

function PageHeader({ searchQuery = "" }: { searchQuery?: string }) {
  return (
    <header className="topbar">
      <SearchInput query={searchQuery} />
    </header>
  );
}

type SidebarRoute = "drive" | "recent" | "favorites" | "trash" | "admin" | null;

function AppShell({
  active,
  profile,
  canManageDocuments,
  canCreate,
  uploadingFromMenu,
  activeFolderId,
  onOpenDriveImport,
  onUpload,
  onCreateFolder,
  onOpenFile,
  onSignOut,
  children,
}: {
  active: SidebarRoute;
  profile: CurrentUser;
  canManageDocuments: boolean;
  canCreate: boolean;
  uploadingFromMenu: boolean;
  activeFolderId: string | null;
  onOpenDriveImport: () => void;
  onUpload: () => void;
  onCreateFolder: () => void;
  onOpenFile: (item: NodeTreeItem) => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const sidebarWidthRef = useRef(sidebarWidth);
  const resize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const resizeListeners = useRef<{
    onPointerMove: (event: PointerEvent) => void;
    onPointerUp: (event: PointerEvent) => void;
  } | null>(null);
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);
  const stopResizing = useCallback(() => {
    if (!resize.current) return;
    resize.current = null;
    const listeners = resizeListeners.current;
    if (listeners) {
      window.removeEventListener("pointermove", listeners.onPointerMove);
      window.removeEventListener("pointerup", listeners.onPointerUp);
      window.removeEventListener("pointercancel", listeners.onPointerUp);
      resizeListeners.current = null;
    }
    document.body.classList.remove("is-resizing-sidebar");
    persistSidebarWidth(sidebarWidthRef.current);
  }, []);
  useEffect(() => {
    const onResize = () => {
      setSidebarWidth((current) => {
        const next = clampSidebarWidth(current);
        sidebarWidthRef.current = next;
        return next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => () => stopResizing(), [stopResizing]);
  function startResizing(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    resize.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidthRef.current,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add("is-resizing-sidebar");
    const onPointerMove = (moveEvent: PointerEvent) => {
      const current = resize.current;
      if (!current || current.pointerId !== moveEvent.pointerId) return;
      const next = clampSidebarWidth(current.startWidth + moveEvent.clientX - current.startX);
      sidebarWidthRef.current = next;
      setSidebarWidth(next);
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      if (resize.current?.pointerId === upEvent.pointerId) stopResizing();
    };
    resizeListeners.current = { onPointerMove, onPointerUp };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }
  const sidebarBounds = sidebarWidthBounds();
  return <div className="app-shell" style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    <Sidebar
      active={active}
      profile={profile}
      canManageDocuments={canManageDocuments}
      canCreate={canCreate}
      uploadingFromMenu={uploadingFromMenu}
      activeFolderId={activeFolderId}
      onOpenDriveImport={onOpenDriveImport}
      onUpload={onUpload}
      onCreateFolder={onCreateFolder}
      onOpenFile={onOpenFile}
      onSignOut={onSignOut}
      sidebarWidth={sidebarWidth}
      sidebarMaxWidth={sidebarBounds.max}
      onResizeStart={startResizing}
    />
    <main className="drive-main"><div className="page-scroll">{children}</div></main>
  </div>;
}

function Sidebar({
  active,
  profile,
  canManageDocuments,
  canCreate,
  uploadingFromMenu,
  activeFolderId,
  onOpenDriveImport,
  onUpload,
  onCreateFolder,
  onOpenFile,
  onSignOut,
  sidebarWidth,
  sidebarMaxWidth,
  onResizeStart,
}: {
  active: SidebarRoute;
  profile: CurrentUser;
  canManageDocuments: boolean;
  canCreate: boolean;
  uploadingFromMenu: boolean;
  activeFolderId: string | null;
  onOpenDriveImport: () => void;
  onUpload: () => void;
  onCreateFolder: () => void;
  onOpenFile: (item: NodeTreeItem) => void;
  onSignOut: () => void;
  sidebarWidth: number;
  sidebarMaxWidth: number;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const canAdmin = profile.status === "ACTIVE" && canAdministerAccounts(profile.systemRole);
  return (
    <aside className="sidebar">
      <div className="brand">
        <Icon name="drive" size={22} />
        <span>Docs Hub</span>
      </div>
      {canManageDocuments && (
        <AddDriveMenu
          pending={uploadingFromMenu}
          canCreate={canCreate}
          onOpenDrive={onOpenDriveImport}
          onUpload={onUpload}
          onCreateFolder={onCreateFolder}
        />
      )}
      <nav aria-label={t("nav.main")}>
        <button
          className={`nav-item${active === "drive" ? " is-active" : ""}`}
          type="button"
          onClick={() => navigate(null)}
        >
          <Icon name="folder" />
          <span>{t("nav.drive")}</span>
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
        <div className="sidebar-divider" />
        {canAdmin && <>
          <button className={`nav-item${active === "admin" ? " is-active" : ""}`} type="button" onClick={() => navigateAdmin()}><Icon name="settings" /><span>{t("nav.admin")}</span></button>
          <div className="sidebar-divider sidebar-divider-after-admin" />
        </>}
        <FolderTree activeFolderId={activeFolderId} onOpenFile={onOpenFile} />
      </nav>
      <AccountMenu profile={profile} onSignOut={onSignOut} />
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={sidebarMaxWidth}
        aria-valuenow={sidebarWidth}
        onPointerDown={onResizeStart}
      />
    </aside>
  );
}

function FolderTree({
  activeFolderId,
  onOpenFile,
}: {
  activeFolderId: string | null;
  onOpenFile: (item: NodeTreeItem) => void;
}) {
  return <DocsHubNodeTree activeFolderId={activeFolderId} onNavigate={navigate} onOpenFile={onOpenFile} />;
}

function DocsHubFolderTree({
  activeFolderId,
  selectedFolderId,
  onNavigate,
  onSelect,
  showRoot = false,
}: {
  activeFolderId?: string | null;
  selectedFolderId?: string | null;
  onNavigate?: (folderId: string) => void;
  onSelect?: (folderId: string | null) => void;
  showRoot?: boolean;
}) {
  return <DocsHubTree
    activeFolderId={activeFolderId}
    selectedFolderId={selectedFolderId}
    onNavigate={onNavigate}
    onSelect={onSelect}
    showRoot={showRoot}
  />;
}

function DocsHubNodeTree({
  activeFolderId,
  onNavigate,
  onOpenFile,
}: {
  activeFolderId?: string | null;
  onNavigate?: (folderId: string) => void;
  onOpenFile: (item: NodeTreeItem) => void;
}) {
  return <DocsHubTree
    activeFolderId={activeFolderId}
    onNavigate={onNavigate}
    onOpenFile={onOpenFile}
    includeFiles
  />;
}

type DocsHubTreeItem = FolderTreeItem | NodeTreeItem;

function isFolderTreeItem(item: DocsHubTreeItem) {
  return !("type" in item) || item.type === "FOLDER";
}

function DocsHubTree({
  activeFolderId,
  selectedFolderId,
  onNavigate,
  onSelect,
  onOpenFile,
  showRoot = false,
  includeFiles = false,
}: {
  activeFolderId?: string | null;
  selectedFolderId?: string | null;
  onNavigate?: (folderId: string) => void;
  onSelect?: (folderId: string | null) => void;
  onOpenFile?: (item: NodeTreeItem) => void;
  showRoot?: boolean;
  includeFiles?: boolean;
}) {
  const rootKey = "__root__";
  const [children, setChildren] = useState<Record<string, DocsHubTreeItem[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(showRoot ? [rootKey] : []));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const childrenRef = useRef(children);
  const loadingRef = useRef(new Set<string>());
  useEffect(() => {
    childrenRef.current = children;
  }, [children]);

  const loadChildren = useCallback(async (parentId: string | null, force = false) => {
    const key = parentId ?? rootKey;
    if (!force && Object.prototype.hasOwnProperty.call(childrenRef.current, key)) return;
    if (loadingRef.current.has(key)) return;
    loadingRef.current.add(key);
    setLoading((current) => new Set(current).add(key));
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      const result = includeFiles
        ? await api.listNodeTree(parentId)
        : await api.listFolderTree(parentId);
      setChildren((current) => ({ ...current, [key]: result.items }));
    } catch {
      setErrors((current) => ({ ...current, [key]: true }));
    } finally {
      loadingRef.current.delete(key);
      setLoading((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, [includeFiles]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadChildren(null), 0);
    return () => window.clearTimeout(timer);
  }, [loadChildren]);

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ parentId?: string | null; nodeId?: string }>).detail;
      if (!detail || !Object.prototype.hasOwnProperty.call(detail, "parentId")) return;
      const parentId = detail.parentId ?? null;
      void loadChildren(parentId, true);
    };
    window.addEventListener("nodes-changed", refresh);
    return () => window.removeEventListener("nodes-changed", refresh);
  }, [loadChildren]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const keys = new Set([rootKey, ...Object.keys(childrenRef.current)]);
      for (const key of keys) {
        if (loadingRef.current.has(key)) continue;
        void loadChildren(key === rootKey ? null : key, true);
      }
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [loadChildren]);

  useEffect(() => {
    if (!activeFolderId) return;
    let active = true;
    void api.breadcrumbPage(activeFolderId).then(async (page) => {
      if (!active) return;
      const folders = page.items.filter((item) => item.type === "FOLDER");
      const ids = folders.map((item) => item.id);
      setExpanded((current) => new Set([...current, ...ids]));
      await loadChildren(null);
      for (const folder of folders) {
        if (!active) return;
        await loadChildren(folder.id);
      }
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [activeFolderId, loadChildren]);

  function toggle(item: DocsHubTreeItem) {
    if (!isFolderTreeItem(item)) return;
    const isOpen = expanded.has(item.id);
    setExpanded((current) => {
      const next = new Set(current);
      if (isOpen) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    if (!isOpen) void loadChildren(item.id);
  }

  function toggleRoot() {
    const isOpen = expanded.has(rootKey);
    setExpanded((current) => {
      const next = new Set(current);
      if (isOpen) next.delete(rootKey);
      else next.add(rootKey);
      return next;
    });
    if (!isOpen) void loadChildren(null);
  }

  function selectFolder(folderId: string | null) {
    if (onSelect) onSelect(folderId);
    else if (folderId) onNavigate?.(folderId);
  }

  function renderItems(parentId: string | null): ReactNode {
    const key = parentId ?? rootKey;
    const items = children[key] ?? [];
    return items.map((item) => {
      const isFolder = isFolderTreeItem(item);
      const isOpen = isFolder && expanded.has(item.id);
      const isActive = isFolder && activeFolderId === item.id;
      const isSelected = selectedFolderId !== undefined && selectedFolderId === item.id;
      const isLoading = loading.has(item.id);
      return (
        <li key={item.id} className="folder-tree-item" role="treeitem" aria-expanded={isFolder ? isOpen : undefined}>
          <div className={`folder-tree-row${isActive ? " is-active" : ""}${isSelected ? " is-selected" : ""}`}>
            {isFolder ? (
              <button
                type="button"
                className={`folder-tree-toggle${isOpen ? " is-open" : ""}`}
                aria-label={isOpen ? t("nav.collapseFolder", { name: item.name }) : t("nav.expandFolder", { name: item.name })}
                onClick={() => toggle(item)}
                disabled={isLoading}
              >
                <Icon name="chevron" size={13} />
              </button>
            ) : <span className="folder-tree-toggle folder-tree-file-spacer" aria-hidden="true" />}
            <button
              type="button"
              className="folder-tree-link"
              aria-current={isActive ? "page" : undefined}
              onClick={() => isFolder ? selectFolder(item.id) : onOpenFile?.(item as NodeTreeItem)}
            >
              <Icon name={isFolder ? "folder" : "file"} size={15} />
              <span>{item.name}</span>
            </button>
          </div>
          {isFolder && isOpen && <ul role="group">
            {loading.has(item.id) && !children[item.id] && <li className="folder-tree-state">{t("common.loading")}</li>}
            {errors[item.id] && <li className="folder-tree-state"><span>{t("errors.generic")}</span><button type="button" className="button" onClick={() => void loadChildren(item.id, true)}>{t("common.retry")}</button></li>}
            {renderItems(item.id)}
          </ul>}
        </li>
      );
    });
  }

  const rootOpen = expanded.has(rootKey);
  const rootSelected = selectedFolderId !== undefined && selectedFolderId === null;
  const treeLabel = t(includeFiles ? "nav.docsHubTree" : "nav.docsHubFolders");

  return (
    <section className="folder-tree" aria-label={treeLabel}>
      {!showRoot && <div className="folder-tree-heading">{treeLabel}</div>}
      <ul role="tree">
        {showRoot && <li className="folder-tree-item" role="treeitem" aria-expanded={rootOpen}>
          <div className={`folder-tree-row${rootSelected ? " is-selected" : ""}`}>
            <button type="button" className={`folder-tree-toggle${rootOpen ? " is-open" : ""}`} aria-label={rootOpen ? t("nav.collapseFolder", { name: t("drive.docsHubRoot") }) : t("nav.expandFolder", { name: t("drive.docsHubRoot") })} onClick={toggleRoot} disabled={loading.has(rootKey)}><Icon name="chevron" size={13} /></button>
            <button type="button" className="folder-tree-link" onClick={() => selectFolder(null)}><Icon name="folder" size={15} /><span>{t("drive.docsHubRoot")}</span></button>
          </div>
          {rootOpen && <ul role="group">
            {loading.has(rootKey) && !children[rootKey] && <li className="folder-tree-state">{t("common.loading")}</li>}
            {errors[rootKey] && <li className="folder-tree-state"><span>{t("errors.generic")}</span><button type="button" className="button" onClick={() => void loadChildren(null, true)}>{t("common.retry")}</button></li>}
            {renderItems(null)}
          </ul>}
        </li>}
        {!showRoot && renderItems(null)}
      </ul>
    </section>
  );
}

function AccountMenu({ profile, onSignOut }: { profile: CurrentUser; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const canAdmin = profile.status === "ACTIVE" && canAdministerAccounts(profile.systemRole);
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

function DriveApp({
  canCreate,
  canManageDocuments,
  uploading,
  onCreateFolder,
  onUpload,
}: {
  canCreate: boolean;
  canManageDocuments: boolean;
  uploading: boolean;
  onCreateFolder: () => void;
  onUpload: () => void;
}) {
  const [folderId, setFolderId] = useState(currentFolderId);
  const [sort, setSort] = useState<DriveSort>(currentDriveSort);
  const [view, setView] = useState<ViewMode>(() => readViewMode("dochub.drive-view"));
  const [nodes, setNodes] = useState<Node[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [renameNode, setRenameNode] = useState<Node | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewActivation = useRef(0);
  const [shareNode, setShareNode] = useState<Node | null>(null);
  const [trashNode, setTrashNode] = useState<Node | null>(null);
  const [removeDriveNode, setRemoveDriveNode] = useState<Node | null>(null);
  const [versionNode, setVersionNode] = useState<Node | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [driveIntegration, setDriveIntegration] = useState<DriveIntegration | null>(null);
  const [driveIntegrationLoading, setDriveIntegrationLoading] = useState(true);
  const loadController = useRef<AbortController | null>(null);
  const hasLoadedRef = useRef(false);
  const load = useCallback(async (id: string | null, options: { silent?: boolean } = {}) => {
    const silent = options.silent ?? false;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    if (!silent) {
      setStatus("loading");
      setError("");
    }
    try {
      const [page, trail] = await Promise.all([
        api.listNodes(id, sort.by, sort.direction, controller.signal),
        id ? api.breadcrumb(id, controller.signal) : Promise.resolve([]),
      ]);
      if (controller.signal.aborted) return;
      setNodes(page.items);
      setBreadcrumbs(trail);
      hasLoadedRef.current = true;
      setStatus("ready");
    } catch (requestError) {
      if (controller.signal.aborted) return;
      if (silent) {
        if (hasLoadedRef.current) setStatus("ready");
        else {
          setStatus("error");
          setError(displayError(requestError));
        }
        return;
      }
      setStatus("error");
      setError(displayError(requestError));
    }
  }, [sort]);
  useEffect(() => () => loadController.current?.abort(), []);
  useEffect(() => {
    const onPopState = () => {
      setFolderId(currentFolderId());
      setSort(currentDriveSort());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    let active = true;
    void api.driveIntegration().then(
      (integration) => active && setDriveIntegration(integration),
      () => active && setDriveIntegration(null),
    ).finally(() => active && setDriveIntegrationLoading(false));
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(folderId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [folderId, load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void load(folderId, { silent: true });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [folderId, load]);
  useEffect(() => {
    const refreshAfterNodeChange = (event: Event) => {
      const parentId = (event as CustomEvent<{ parentId?: string | null }>).detail?.parentId;
      if (parentId === folderId) void load(folderId, { silent: true });
    };
    window.addEventListener("nodes-changed", refreshAfterNodeChange);
    return () => window.removeEventListener("nodes-changed", refreshAfterNodeChange);
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
  async function rename(node: Node, name: string) {
    await api.renameNode(node.id, name);
    window.dispatchEvent(new CustomEvent("nodes-changed", { detail: { parentId: node.parentId, nodeId: node.id } }));
    await load(folderId);
    setNotice({ tone: "success", message: t("files.renamed") });
  }
  function changeSort(next: DriveSort) {
    setSort(next);
    const path = drivePath(folderId, next);
    if (`${window.location.pathname}${window.location.search}` !== path) {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }
  function changeView(next: ViewMode) {
    setView(next);
    persistViewMode("dochub.drive-view", next);
  }
  async function openFile(node: Node) {
    const activation = ++previewActivation.current;
    await openFileActivation(
      node,
      (nextPreview) => { if (activation === previewActivation.current) setPreview(nextPreview); },
      (notice) => { if (activation === previewActivation.current) setNotice(notice); },
    );
  }
  function closePreview() {
    previewActivation.current += 1;
    setPreview(null);
  }
  async function moveToTrash(node: Node) {
    await api.moveToTrash(node.id);
    window.dispatchEvent(new CustomEvent("nodes-changed", { detail: { parentId: node.parentId, nodeId: node.id } }));
    setNodes((items) => items.filter((item) => item.id !== node.id));
    setNotice({ tone: "success", message: t("files.movedToTrash", { name: node.name }) });
  }
  async function removeDriveReference(node: Node) {
    try {
      await api.removeDriveReference(node.id);
      window.dispatchEvent(new CustomEvent("nodes-changed", { detail: { parentId: node.parentId, nodeId: node.id } }));
      setNodes((items) => items.filter((item) => item.id !== node.id));
      setRemoveDriveNode(null);
      setNotice({ tone: "success", message: t("drive.removedFromDocsHub", { name: node.name }) });
    } catch (requestError) {
      setNotice({ tone: "error", message: displayError(requestError) });
    }
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
  const canCreateHere = canCreate;
  return (
    <>
        <PageHeader />
        <Toast notice={notice} onDismiss={() => setNotice(null)} />
        <section className="drive-content" aria-label={t("files.title")}>
          <div className="drive-space-toolbar">
            <Breadcrumbs items={breadcrumbs} folderId={folderId} />
            <div className="drive-space-controls">
              <ViewToggle value={view} onChange={changeView} label={t("drive.viewMode")} />
              <SortControls sort={sort} onChange={changeSort} />
              <button
                type="button"
                className="icon-button"
                onClick={() => void load(folderId)}
                aria-label={t("files.refresh")}
              >
                <Icon name="refresh" />
              </button>
            </div>
          </div>
          {status === "loading" && <LoadingRows />}
          {status === "error" && (
            <ErrorState message={error} onRetry={() => void load(folderId)} />
          )}
          {status === "ready" && nodes.length === 0 && (
            <EmptyState
              canCreateHere={canCreateHere}
              canUpload={canManageDocuments}
              uploadDisabled={uploading || driveIntegrationLoading || !driveIntegration?.connected || !driveIntegration.configured || !driveIntegration.canWrite}
              onFolder={onCreateFolder}
              onUpload={onUpload}
            />
          )}
          {status === "ready" && nodes.length > 0 && (
            <FileList
              nodes={nodes}
              onFolder={(id) => navigate(id)}
              onRename={setRenameNode}
              onShare={setShareNode}
              onTrash={setTrashNode}
              onRemoveDrive={canManageDocuments ? setRemoveDriveNode : undefined}
              onVersions={setVersionNode}
              onOpen={openFile}
              onNotice={setNotice}
              favoriteIds={favoriteIds}
              onFavorite={toggleFavorite}
              viewMode={view}
            />
          )}
        </section>
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
          title={trashNode.type === "FOLDER" ? t("files.moveFolderToTrashTitle") : t("files.moveToTrash")}
          message={trashNode.type === "FOLDER" ? t("files.moveFolderToTrashConfirm", { name: trashNode.name }) : t("files.moveToTrashConfirm", { name: trashNode.name })}
          action={t("files.moveToTrash")}
          onClose={() => setTrashNode(null)}
          onConfirm={() => moveToTrash(trashNode)}
          onNotice={setNotice}
        />
      )}
      {removeDriveNode && (
        <ConfirmDialog
          title={t("drive.removeFromDocsHub")}
          message={t("drive.removeFromDocsHubConfirm", { name: removeDriveNode.name })}
          action={t("drive.removeFromDocsHub")}
          onClose={() => setRemoveDriveNode(null)}
          onConfirm={() => removeDriveReference(removeDriveNode)}
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
      {preview && (
        <PreviewDialog
          key={previewIsUnavailable(preview) ? `unavailable-${preview.nodeId}` : previewIsLoading(preview) ? `loading-${preview.nodeId}` : preview.sessionId}
          preview={preview}
          onClose={closePreview}
          onDownload={() => downloadPreview(preview)}
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
        {t("nav.drive")}
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

function ViewToggle({ value, onChange, label }: { value: ViewMode; onChange: (value: ViewMode) => void; label: string }) {
  return <div className="view-toggle" role="group" aria-label={label}>
    <button type="button" className={value === "list" ? "is-active" : ""} aria-pressed={value === "list"} aria-label={t("drive.listView")} onClick={() => onChange("list")}><Icon name="list" size={16} /></button>
    <button type="button" className={value === "grid" ? "is-active" : ""} aria-pressed={value === "grid"} aria-label={t("drive.gridView")} onClick={() => onChange("grid")}><Icon name="grid" size={16} /></button>
  </div>;
}

function SortControls({ sort, onChange }: { sort: DriveSort; onChange: (sort: DriveSort) => void }) {
  return <div className="sort-controls" role="group" aria-label={t("files.sortBy")}>
    {(["name", "lastModified"] as const).map((by) => {
      const active = sort.by === by;
      const next = nextDriveSort(sort, by);
      const label = by === "name" ? t("common.name") : t("common.lastModified");
      return <button
        key={by}
        type="button"
        className={active ? "is-active" : ""}
        aria-pressed={active}
        aria-label={`${label}, ${t(next.direction === "asc" ? "common.sortAscending" : "common.sortDescending")}`}
        onClick={() => onChange(next)}
      >
        {label}{active ? ` ${sort.direction === "asc" ? "↑" : "↓"}` : ""}
      </button>;
    })}
  </div>;
}

function FileList({
  nodes,
  onFolder,
  onRename,
  onShare,
  onTrash,
  onRemoveDrive,
  onVersions,
  onOpen,
  onOpenInGoogle = openDriveInGoogle,
  onNotice,
  favoriteIds,
  onFavorite,
  viewMode = "list",
  dateLabel = t("common.lastModified"),
  showLastModified = true,
  canManageDocuments = false,
}: {
  nodes: Node[];
  onFolder: (id: string) => void;
  onRename: (node: Node) => void;
  onShare: (node: Node) => void;
  onTrash: (node: Node) => void;
  onRemoveDrive?: (node: Node) => void;
  onVersions: (node: Node) => void;
  onOpen: (node: Node) => void;
  onOpenInGoogle?: (node: Node) => void;
  onNotice: (notice: Notice) => void;
  favoriteIds: ReadonlySet<string>;
  onFavorite: (node: Node) => void;
  viewMode?: ViewMode;
  dateLabel?: string;
  showLastModified?: boolean;
  canManageDocuments?: boolean;
}) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  if (viewMode === "grid") {
    return <FileGrid
      nodes={nodes}
      onFolder={onFolder}
      onRename={onRename}
      onShare={onShare}
      onTrash={onTrash}
      onRemoveDrive={onRemoveDrive}
      onVersions={onVersions}
      onOpen={onOpen}
      onOpenInGoogle={onOpenInGoogle}
      onNotice={onNotice}
      favoriteIds={favoriteIds}
      onFavorite={onFavorite}
      onMenuState={setOpenMenuId}
      openMenuId={openMenuId}
      canManageDocuments={canManageDocuments}
    />;
  }
  return (
    <div className="file-table-wrap">
      <table className={`file-table${showLastModified ? " with-last-modified" : ""}`}>
        <thead>
          <tr>
            <th scope="col">{t("common.name")}</th>
            <th scope="col">{t("common.type")}</th>
            {showLastModified ? (
              <th scope="col">{t("common.lastModified")}</th>
            ) : (
              <th scope="col">{dateLabel}</th>
            )}
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
              onRemoveDrive={onRemoveDrive}
              canManageDocuments={canManageDocuments}
              onVersions={onVersions}
              onOpen={onOpen}
              onOpenInGoogle={onOpenInGoogle}
              onNotice={onNotice}
              isFavorite={favoriteIds.has(node.id)}
              onFavorite={onFavorite}
              showLastModified={showLastModified}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FileGrid({
  nodes,
  onFolder,
  onRename,
  onShare,
  onTrash,
  onRemoveDrive,
  onVersions,
  onOpen,
  onOpenInGoogle,
  onNotice,
  favoriteIds,
  onFavorite,
  openMenuId,
  onMenuState,
  canManageDocuments,
}: {
  nodes: Node[];
  onFolder: (id: string) => void;
  onRename: (node: Node) => void;
  onShare: (node: Node) => void;
  onTrash: (node: Node) => void;
  onRemoveDrive?: (node: Node) => void;
  onVersions: (node: Node) => void;
  onOpen: (node: Node) => void;
  onOpenInGoogle: (node: Node) => void;
  onNotice: (notice: Notice) => void;
  favoriteIds: ReadonlySet<string>;
  onFavorite: (node: Node) => void;
  openMenuId: string | null;
  onMenuState: (id: string | null) => void;
  canManageDocuments: boolean;
}) {
  return <div className="file-grid">{nodes.map((node) => <FileTile
    key={node.id}
    node={node}
    menuOpen={openMenuId === node.id}
    onToggleMenu={() => onMenuState(openMenuId === node.id ? null : node.id)}
    onCloseMenu={() => onMenuState(null)}
    onFolder={onFolder}
    onRename={onRename}
    onShare={onShare}
    onTrash={onTrash}
    onRemoveDrive={onRemoveDrive}
    onVersions={onVersions}
    onOpen={onOpen}
    onOpenInGoogle={onOpenInGoogle}
    onNotice={onNotice}
    isFavorite={favoriteIds.has(node.id)}
    onFavorite={onFavorite}
    canManageDocuments={canManageDocuments}
  />)}</div>;
}

function FileTile({
  node,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onFolder,
  onRename,
  onShare,
  onTrash,
  onRemoveDrive,
  onVersions,
  onOpen,
  onOpenInGoogle,
  onNotice,
  isFavorite,
  onFavorite,
  canManageDocuments,
}: {
  node: Node;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onFolder: (id: string) => void;
  onRename: (node: Node) => void;
  onShare: (node: Node) => void;
  onTrash: (node: Node) => void;
  onRemoveDrive?: (node: Node) => void;
  onVersions: (node: Node) => void;
  onOpen: (node: Node) => void;
  onOpenInGoogle: (node: Node) => void;
  onNotice: (notice: Notice) => void;
  isFavorite: boolean;
  onFavorite: (node: Node) => void;
  canManageDocuments: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const isFolder = node.type === "FOLDER";
  const canOpen = canOpenNode(node);
  async function download() {
    try {
      await api.download(node);
    } catch (error) {
      onNotice({ tone: "error", message: displayError(error) });
    }
  }
  return <article className="file-tile">
    <div className="file-tile-main">
      <button type="button" className="file-tile-open" onClick={() => isFolder ? onFolder(node.id) : void onOpen(node)} disabled={!canOpen}>
        <Icon name={isFolder ? "folder" : "file"} size={25} />
        <strong title={node.name}>{node.name}</strong>
        <span>{isFolder ? t("drive.types.FOLDER") : node.backing?.type === "GOOGLE_DRIVE" ? driveTypeLabel(node.backing.normalizedType) : t("drive.types.BINARY")}</span>
      </button>
      <button ref={trigger} type="button" className="icon-button file-tile-actions" aria-label={t("files.fileActions", { name: node.name })} aria-haspopup="menu" aria-expanded={menuOpen} onClick={onToggleMenu}><Icon name="more" /></button>
      {menuOpen && <RowMenu id={`file-menu-${node.id}`} trigger={trigger} onClose={onCloseMenu}>
        <button type="button" role="menuitem" onClick={() => { onCloseMenu(); onFavorite(node); }}><Icon name="star" size={16} />{isFavorite ? t("files.unfavorite") : t("files.favorite")}</button>
        <button type="button" role="menuitem" disabled={!canOpen} onClick={() => { onCloseMenu(); if (isFolder) onFolder(node.id); else void onOpen(node); }}><Icon name={isFolder ? "folder" : "file"} size={16} />{openActionLabel(node)}</button>
        {!isFolder && node.backing?.type === "GOOGLE_DRIVE" && node.backing.webViewLink && <button type="button" role="menuitem" onClick={() => { onCloseMenu(); onOpenInGoogle(node); }}><Icon name="drive" size={16} />{t("drive.openInGoogle")}</button>}
        {!isFolder && hasCapability(node, "DOWNLOAD") && <button type="button" role="menuitem" onClick={() => { onCloseMenu(); void download(); }}><Icon name="download" size={16} />{t("common.download")}</button>}
        {hasCapability(node, "RENAME") && <button type="button" role="menuitem" onClick={() => { onCloseMenu(); onRename(node); }}><Icon name="edit" size={16} />{t("files.rename")}</button>}
        {!isFolder && <button type="button" role="menuitem" onClick={() => { onCloseMenu(); onVersions(node); }}><Icon name="recent" size={16} />{t("files.versionHistory")}</button>}
        {node.backing?.type !== "GOOGLE_DRIVE" && hasCapability(node, "SHARE") && <button type="button" role="menuitem" onClick={() => { onCloseMenu(); onShare(node); }}><Icon name="share" size={16} />{t("files.share")}</button>}
        {hasCapability(node, "DELETE") && <button type="button" role="menuitem" className="menu-danger" onClick={() => { onCloseMenu(); onTrash(node); }}><Icon name="trash" size={16} />{t("files.moveToTrash")}</button>}
        {node.backing?.type === "GOOGLE_DRIVE" && canManageDocuments && onRemoveDrive && <button type="button" role="menuitem" className="menu-danger" onClick={() => { onCloseMenu(); onRemoveDrive(node); }}><Icon name="trash" size={16} />{t("drive.removeFromDocsHub")}</button>}
      </RowMenu>}
    </div>
    <div className="file-tile-meta"><span>{formatLastModified(node.lastModified.at)}</span></div>
  </article>;
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
  onRemoveDrive,
  onVersions,
  onOpen,
  onOpenInGoogle,
  onNotice,
  isFavorite,
  onFavorite,
  showLastModified,
  canManageDocuments,
}: {
  node: Node;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onFolder: (id: string) => void;
  onRename: (node: Node) => void;
  onShare: (node: Node) => void;
  onTrash: (node: Node) => void;
  onRemoveDrive?: (node: Node) => void;
  onVersions: (node: Node) => void;
  onOpen: (node: Node) => void;
  onOpenInGoogle: (node: Node) => void;
  onNotice: (notice: Notice) => void;
  isFavorite: boolean;
  onFavorite: (node: Node) => void;
  showLastModified: boolean;
  canManageDocuments: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const isFolder = node.type === "FOLDER";
  const canOpen =
    canOpenNode(node);
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
          <span>{node.name}{node.backing?.type === "GOOGLE_DRIVE" && node.backing.sourceStatus !== "CONNECTED" ? <small className="drive-source-status"> ({driveSourceStatusLabel(node.backing.sourceStatus)})</small> : null}</span>
        </button>
      </td>
      <td>{node.backing?.type === "GOOGLE_DRIVE" ? driveTypeLabel(node.backing.normalizedType) : node.type === "FOLDER" ? driveTypeLabel("FOLDER") : "—"}</td>
      {showLastModified ? (
        <td className="modified">{formatLastModified(node.lastModified.at)}</td>
      ) : (
        <td className="modified">{formatDate(node.updatedAt)}</td>
      )}
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
              <Icon name={isFolder ? "folder" : "file"} size={16} />
              {openActionLabel(node)}
            </button>
            {!isFolder && node.backing?.type === "GOOGLE_DRIVE" && node.backing.webViewLink && (
              <button type="button" role="menuitem" onClick={() => { onCloseMenu(); onOpenInGoogle(node); }}>
                <Icon name="drive" size={16} />
                {t("drive.openInGoogle")}
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
                <Icon name="recent" size={16} />
                {t("files.versionHistory")}
              </button>
            )}
            {node.backing?.type !== "GOOGLE_DRIVE" && hasCapability(node, "SHARE") && (
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
            {node.backing?.type === "GOOGLE_DRIVE" && canManageDocuments && onRemoveDrive && (
              <button
                type="button"
                role="menuitem"
                className="menu-danger"
                onClick={() => {
                  onCloseMenu();
                  onRemoveDrive(node);
                }}
              >
                <Icon name="trash" size={16} />
                {t("drive.removeFromDocsHub")}
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
  triggerId,
  onClose,
  children,
}: {
  id: string;
  trigger?: RefObject<HTMLButtonElement | null>;
  triggerId?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: -9999, left: -9999 });
  function anchor() {
    return triggerId
      ? document.getElementById(triggerId)
      : trigger?.current ?? null;
  }
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
      const triggerElement = anchor();
      const element = menu.current;
      if (!triggerElement || !element) return;
      const rect = triggerElement.getBoundingClientRect();
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
      anchor()?.focus();
    };
    window.addEventListener("resize", closeForViewportChange);
    window.addEventListener("scroll", closeForViewportChange, true);
    return () => {
      window.removeEventListener("resize", closeForViewportChange);
      window.removeEventListener("scroll", closeForViewportChange, true);
    };
  // The anchor is a DOM lookup for the portal trigger and is intentionally not
  // a reactive value.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, trigger, triggerId]);
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
        !anchor()?.contains(event.target as globalThis.Node)
      ) {
        onClose();
        anchor()?.focus();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        anchor()?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, trigger, triggerId]);
  useEffect(() => {
    const menuElement = menu.current;
    const triggerElement = anchor();
    return () => {
      if (document.activeElement && menuElement?.contains(document.activeElement)) {
        triggerElement?.focus();
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, triggerId]);
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
    setPending(true);
    setError("");
    try {
      if (!sharing) throw new Error("Document URL is unavailable");
      await navigator.clipboard.writeText(sharing.documentUrl);
      onNotice({ tone: "success", message: t("share.linkCopied") });
    } catch {
      onNotice({ tone: "error", message: t("share.linkCopyFailed") });
    } finally {
      setPending(false);
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
                    <div className="search-field search-field-principal">
                      <Icon name="search" size={17} />
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
              <label className="general-access-control">
                <select
                  aria-label={t("share.generalAccess")}
                  value={sharing.generalAccessRole}
                  disabled={pending}
                  onChange={(event) => {
                    const role = event.target.value as SharingState["generalAccessRole"];
                    void mutate(async () => {
                      await api.setGeneralAccessRole(node.id, role);
                    }, t("share.generalAccessUpdated"));
                  }}
                >
                  <option value="RESTRICTED">{t("share.restricted")}</option>
                  <option value="VIEWER">{t("share.anyoneWithLinkViewer")}</option>
                  <option value="EDITOR">{t("share.anyoneWithLinkEditor")}</option>
                </select>
                <small>{sharing.generalAccessRole === "RESTRICTED"
                  ? t("share.onlyPeopleCanView")
                  : sharing.generalAccessRole === "EDITOR" ? t("share.anyoneCanEdit") : t("share.anyoneCanView")}</small>
              </label>
              {sharing.generalAccessRole !== "RESTRICTED" && (
                <div className="issued-link-row">
                  <strong>{t("share.documentLink")}</strong>
                  <button type="button" className="button button-primary" disabled={pending} onClick={() => void copyLink()}>{t("share.copyLink")}</button>
                </div>
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
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewActivation = useRef(0);
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
    const activation = ++previewActivation.current;
    await openFileActivation(
      node,
      (nextPreview) => { if (activation === previewActivation.current) setPreview(nextPreview); },
      (notice) => { if (activation === previewActivation.current) setNotice(notice); },
    );
  }

  function closePreview() {
    previewActivation.current += 1;
    setPreview(null);
  }

  async function rename(node: Node, name: string) {
    const updated = await api.renameNode(node.id, name);
    window.dispatchEvent(new CustomEvent("nodes-changed", { detail: { parentId: node.parentId, nodeId: node.id } }));
    setItems((current) => current.map((item) => item.id === node.id ? { ...item, ...updated } : item));
    setNotice({ tone: "success", message: t("files.renamed") });
  }

  async function moveToTrash(node: Node) {
    await api.moveToTrash(node.id);
    window.dispatchEvent(new CustomEvent("nodes-changed", { detail: { parentId: node.parentId, nodeId: node.id } }));
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
        <PageHeader />
        <section className="drive-content" aria-label={title}>
          <div className="content-toolbar">
            <h1 className="page-title">{title}</h1>
            <button type="button" className="icon-button" onClick={() => void load()} aria-label={t("files.refreshCollection", { name: title })}>
              <Icon name="refresh" />
            </button>
          </div>
          {status === "loading" && <LoadingRows label={`${t("common.loading")} ${title.toLowerCase()}`} />}
          {status === "error" && <CollectionError title={title} message={error} onRetry={() => void load()} />}
          {status === "ready" && displayItems.length === 0 && <SearchState title={emptyTitle} />}
          {status === "ready" && displayItems.length > 0 && <FileList nodes={displayItems} onFolder={(id) => navigate(id)} onRename={setRenameNode} onShare={setShareNode} onTrash={setTrashNode} onVersions={setVersionNode} onOpen={openFile} onNotice={setNotice} favoriteIds={favoriteIds} onFavorite={toggleFavorite} dateLabel={kind === "recent" ? t("files.dateLastOpened") : t("files.dateAdded")} showLastModified={false} />}
        </section>
      <Toast notice={notice} onDismiss={() => setNotice(null)} />
      {renameNode && <NameDialog title={t("files.rename")} action={t("common.save")} initialValue={renameNode.name} onClose={() => setRenameNode(null)} onSubmit={(name) => rename(renameNode, name)} />}
      {shareNode && <ShareDialog node={shareNode} onClose={() => setShareNode(null)} onNotice={setNotice} />}
      {trashNode && <ConfirmDialog title={trashNode.type === "FOLDER" ? t("files.moveFolderToTrashTitle") : t("files.moveToTrash")} message={trashNode.type === "FOLDER" ? t("files.moveFolderToTrashConfirm", { name: trashNode.name }) : t("files.moveToTrashConfirm", { name: trashNode.name })} action={t("files.moveToTrash")} onClose={() => setTrashNode(null)} onConfirm={() => moveToTrash(trashNode)} onNotice={setNotice} />}
      {versionNode && <VersionDialog node={versionNode} onClose={() => setVersionNode(null)} onNotice={setNotice} />}
      {preview && (
        <PreviewDialog
          key={previewIsUnavailable(preview) ? `unavailable-${preview.nodeId}` : previewIsLoading(preview) ? `loading-${preview.nodeId}` : preview.sessionId}
          preview={preview}
          onClose={closePreview}
          onDownload={() => downloadPreview(preview)}
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
  const previewActivation = useRef(0);
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

  const retry = useCallback(async () => {
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
  }, [loadLocations, normalizedQuery]);

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
    const activation = ++previewActivation.current;
    try {
      const node = await api.getNode(item.id);
      await openFileActivation(
        node,
        (nextPreview) => { if (activation === previewActivation.current) setPreview(nextPreview); },
        (notice) => { if (activation === previewActivation.current) setNotice(notice); },
      );
    } catch (requestError) {
      setNotice({ tone: "error", message: displayError(requestError) });
    }
  }

  function closePreview() {
    previewActivation.current += 1;
    setPreview(null);
  }

  return (
    <>
        <PageHeader key={query} searchQuery={query} />
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
      {preview && (
        <PreviewDialog
          key={previewIsUnavailable(preview) ? `unavailable-${preview.nodeId}` : previewIsLoading(preview) ? `loading-${preview.nodeId}` : preview.sessionId}
          preview={preview}
          onClose={closePreview}
          onDownload={() => downloadPreview(preview)}
        />
      )}
    </>
  );
}

function searchLocationLabel(location: SearchLocation | null | undefined) {
  if (location === undefined) return t("search.loadingLocation");
  if (location === null) return t("search.locationUnavailable");
  const parents = location.items.slice(0, -1).map((item) => item.name);
  if (!parents.length) return location.truncated ? t("search.sharedLocation") : t("nav.drive");
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
            <td><button type="button" className="file-name" onClick={() => void onOpen(item)}><Icon name={item.type === "FOLDER" ? "folder" : "file"} size={19} /><span>{item.name}</span></button>{item.matchKind === "CONTENT" && item.snippet && <p className="search-snippet">{item.snippet}</p>}</td>
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
        <PageHeader />
        <section className="drive-content" aria-label={t("trash.title")}>
          <div className="content-toolbar">
            <h1 className="page-title">{t("trash.title")}</h1>
            <button type="button" className="icon-button" onClick={() => void load()} aria-label={t("trash.refresh")}>
              <Icon name="refresh" />
            </button>
          </div>
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
  const [versions, setVersions] = useState<VersionHistoryItem[] | null>(null);
  const [currentRevision, setCurrentRevision] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const restoreOperationIds = useRef(new Map<string, string>());
  const dialog = useDialogFocus();
  const load = useCallback(async () => {
    setError("");
    try {
      const result = await api.listVersions(node.id);
      setVersions(result.items);
      // Legacy local history has no provider revision marker; its existing
      // restore path still performs its own authorization/locking.
      setCurrentRevision(result.currentRevision ?? "legacy");
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
  async function restore(version: VersionHistoryItem) {
    const number = "versionNumber" in version ? version.versionNumber : version.sequence;
    if (!window.confirm(t("versions.restoreConfirm", { number }))) return;
    setPending(version.id);
    setError("");
    try {
      const operationId = restoreOperationIds.current.get(version.id) ?? crypto.randomUUID();
      restoreOperationIds.current.set(version.id, operationId);
      await api.restoreVersion(node.id, version.id, currentRevision, operationId);
      restoreOperationIds.current.delete(version.id);
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
                <strong>{t("versions.version", { number: "versionNumber" in version ? version.versionNumber : version.sequence })}</strong>
                {version.isCurrent && <span className="version-current">{t("versions.current")}</span>}
              </div>
              <div className="version-metadata">
                <span className="version-attribution">
                  <strong>{"actor" in version ? actorLabel(version.actor) : version.actorDisplayName ?? t("actors.UNKNOWN")}</strong>
                  <span aria-hidden="true"> · </span>
                  <span>{formatVersionTimestamp(version.createdAt)}</span>
                </span>
                <span>{formatVersionSource(version.source)}</span>
                <span>{formatBytes(version.sizeBytes)}</span>
              </div>
              <div className="version-actions">
                {hasCapability(node, "DOWNLOAD") && <button type="button" className="version-action" disabled={pending !== null} onClick={() => void api.downloadVersion(node, version).catch((requestError) => onNotice({ tone: "error", message: displayError(requestError) }))}>{t("versions.downloadVersion")}</button>}
                {!version.isCurrent && hasCapability(node, "RESTORE_VERSION") && <button type="button" className="version-action" disabled={pending !== null || !currentRevision} onClick={() => void restore(version)}>{pending === version.id ? t("common.restoring") : t("versions.restoreThisVersion")}</button>}
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
  canUpload,
  uploadDisabled,
  onFolder,
  onUpload,
}: {
  canCreateHere: boolean;
  canUpload: boolean;
  uploadDisabled: boolean;
  onFolder: () => void;
  onUpload: () => void;
}) {
  return (
    <div className="content-state">
      <h1>{t("files.noFiles")}</h1>
      <p>{t("files.noFilesDescription")}</p>
      {(canCreateHere || canUpload) && (
        <div>
          {canCreateHere && <button type="button" className="button" onClick={onFolder}>
            {t("files.newFolder")}
          </button>}
          {canUpload && <button
            type="button"
            className="button button-primary"
            onClick={onUpload}
            disabled={uploadDisabled}
          >
            {uploadDisabled ? t("files.uploading") : t("files.upload")}
          </button>}
        </div>
      )}
    </div>
  );
}
function AddDriveMenu({
  pending,
  canCreate,
  onOpenDrive,
  onUpload,
  onCreateFolder,
}: {
  pending: boolean;
  canCreate: boolean;
  onOpenDrive: () => void;
  onUpload: () => void;
  onCreateFolder: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const triggerElement = trigger.current;
      const menuElement = menu.current;
      if (!triggerElement || !menuElement) return;

      const triggerRect = triggerElement.getBoundingClientRect();
      const width = Math.min(220, window.innerWidth - 24);
      menuElement.style.width = `${width}px`;
      const menuRect = menuElement.getBoundingClientRect();
      const gap = 6;
      const maxLeft = Math.max(12, window.innerWidth - menuRect.width - 12);
      const left = Math.min(maxLeft, Math.max(12, triggerRect.left));
      const preferredBelow = triggerRect.bottom + gap;
      const preferredAbove = triggerRect.top - menuRect.height - gap;
      const top = preferredBelow + menuRect.height <= window.innerHeight
        ? preferredBelow
        : Math.min(Math.max(0, preferredAbove), Math.max(0, window.innerHeight - menuRect.height));
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
      if (event instanceof KeyboardEvent && event.key === "Escape") {
        setOpen(false);
      } else if (
        event instanceof MouseEvent &&
        !menu.current?.contains(event.target as globalThis.Node) &&
        !trigger.current?.contains(event.target as globalThis.Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return <div className="new-menu">
    <button
      ref={trigger}
      type="button"
      className="button button-primary"
      aria-haspopup="menu"
      aria-controls={open ? "add-drive-menu-popover" : undefined}
      aria-expanded={open}
      disabled={pending}
      onClick={() => {
        setPosition(null);
        setOpen((value) => !value);
      }}
    >
      <Icon name="plus" />
      {t("drive.addFrom")}
      <Icon name="chevron-down" size={15} />
    </button>
    {open && createPortal(
      <div
        ref={menu}
        id="add-drive-menu-popover"
        className="new-menu-popover"
        role="menu"
        style={{
          top: position?.top ?? 0,
          left: position?.left ?? 0,
          width: position?.width,
          visibility: position ? "visible" : "hidden",
        }}
      >
        <button type="button" role="menuitem" disabled={pending} onClick={() => { setOpen(false); onUpload(); }}>
          <Icon name="upload" />
          {t("files.upload")}
        </button>
        <button type="button" role="menuitem" disabled={pending} onClick={() => { setOpen(false); onOpenDrive(); }}>
          <Icon name="drive" />
          {t("drive.addFromGoogleDrive")}
        </button>
        <div className="new-menu-divider" />
        <button type="button" role="menuitem" disabled={pending || !canCreate} onClick={() => { setOpen(false); onCreateFolder(); }}>
          <Icon name="folder" />
          {t("files.newFolder")}
        </button>
      </div>,
      document.body,
    )}
  </div>;
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

function DocumentAccessState({ kind, showSignIn, message }: {
  kind: "denied" | "unavailable";
  showSignIn?: boolean;
  message?: string;
}) {
  const denied = kind === "denied";
  return (
    <main className="document-state-page">
      <section className="document-state-card">
        <h1>{denied ? t("document.accessDeniedTitle") : t("document.linkUnavailable")}</h1>
        <p>{denied ? t("document.accessDeniedMessage") : t("document.linkUnavailableMessage")}</p>
        {message && <p className="document-state-detail">{message}</p>}
        {showSignIn && <a className="button button-primary" href={api.googleAuthUrl()}>{t("document.signIn")}</a>}
      </section>
    </main>
  );
}

type PreviewDialogProps = {
  preview: Preview;
  onClose: () => void;
  onDownload: () => Promise<void>;
};

function PreviewDialog(props: PreviewDialogProps) {
  const key = previewIsLoading(props.preview)
    ? `loading:${props.preview.nodeId}`
    : previewIsUnavailable(props.preview)
      ? `unavailable:${props.preview.nodeId}:${props.preview.contentUrl ?? ""}`
      : `available:${props.preview.nodeId}:${props.preview.contentUrl}`;
  return <PreviewDialogContent key={key} {...props} />;
}

function PreviewDialogContent({
  preview,
  onClose,
  onDownload,
}: PreviewDialogProps) {
  const dialog = useDialogFocus();
  const [state, setState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const [downloadError, setDownloadError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyName, setCopyName] = useState("");
  const [documentDirty, setDocumentDirty] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("view");
  const [workspaceActions, setWorkspaceActions] = useState<WorkspaceActions | null>(null);
  const workspaceActionsRef = useRef<WorkspaceActions | null>(null);
  const documentReady = useCallback(() => setState("ready"), []);
  const documentError = useCallback(() => setState("error"), []);
  const registerWorkspaceActions = useCallback((actions: WorkspaceActions) => {
    workspaceActionsRef.current = actions;
    setWorkspaceActions(actions);
  }, []);
  const requestClose = useCallback(() => {
    if (documentDirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  }, [documentDirty, onClose]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [requestClose]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!documentDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    if (documentDirty) window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [documentDirty]);
  useEffect(() => {
    setActiveEditorDirty(documentDirty);
    return () => setActiveEditorDirty(false);
  }, [documentDirty]);
  const unavailable = previewIsUnavailable(preview);
  const loading = previewIsLoading(preview);
  const session = unavailable || loading ? null : preview;
  const kind = session?.preview?.kind;
  const previewLoading = state === "loading";
  const nativeWorkspace = Boolean(session?.modelUrl && ["document", "spreadsheet", "presentation", "text"].includes(kind ?? ""));
  const retry = () => {
    setState("loading");
    setWorkspaceMode("view");
    workspaceActionsRef.current = null;
    setWorkspaceActions(null);
    setDocumentDirty(false);
    setCopyOpen(false);
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
  function beginSaveAsCopy() {
    if (!workspaceActionsRef.current?.saveAsCopy) return;
    const suggested = preview.filename.replace(/(\.[^.]+)$/u, " - Copy$1");
    setCopyName(suggested);
    setCopyError("");
    setCopyOpen(true);
  }
  async function saveAsCopy() {
    const name = copyName.trim();
    if (!name) { setCopyError("A copy name is required."); return; }
    if (!workspaceActionsRef.current?.saveAsCopy) return;
    try { await workspaceActionsRef.current.saveAsCopy(name.trim()); }
    catch (error) { setCopyError(displayError(error)); return; }
    setCopyOpen(false);
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialog}
        className="preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${t("preview.title")} ${preview.filename}`}
      >
        <header>
          <span>{preview.filename}</span>
          <div>
            {nativeWorkspace && workspaceMode === "edit" && workspaceActions && (
              <>
                <button type="button" className="button" onClick={() => workspaceActionsRef.current?.save()} disabled={!workspaceActions.canSave || workspaceActions.saving}>{workspaceActions.saving ? "Saving…" : "Save"}</button>
                {documentDirty && <button type="button" className="button" onClick={beginSaveAsCopy}>Save as copy</button>}
                <button type="button" className="button" onClick={() => workspaceActionsRef.current?.view()}>View</button>
              </>
            )}
            {nativeWorkspace && workspaceMode === "view" && session?.capabilities?.edit && workspaceActions?.canEdit && (
              <button type="button" className="button" onClick={() => setWorkspaceMode("edit")}>Edit</button>
            )}
            {preview.openInGoogleUrl && (
              <button type="button" className="button" onClick={() => window.open(preview.openInGoogleUrl!, "_blank", "noopener,noreferrer")}>
                {preview.canEditInGoogle ? t("drive.editInGoogle") : t("drive.openInGoogle")}
              </button>
            )}
            {preview.canDownload && !loading && (
              <button type="button" className="button" onClick={() => void download()}>
                {t("common.download")}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={t("preview.close")}
              onClick={requestClose}
            >
              <Icon name="close" />
            </button>
          </div>
        </header>
        {copyError && <div className="preview-error" role="alert">{copyError}</div>}
        {copyOpen && <div className="preview-copy-panel" role="dialog" aria-modal="false" aria-labelledby="preview-copy-title"><strong id="preview-copy-title">Save as copy</strong><label htmlFor="preview-copy-name">Copy name</label><input id="preview-copy-name" autoFocus value={copyName} onChange={(event) => setCopyName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveAsCopy(); } }} maxLength={255} /><div className="dialog-actions"><button type="button" className="button" onClick={() => setCopyOpen(false)}>Cancel</button><button type="button" className="button button-primary" onClick={() => void saveAsCopy()}>Save as copy</button></div></div>}
        <div className="preview-content" aria-busy={previewLoading}>
          {loading ? (
            <PreviewState
              title={t("preview.loading")}
              message={t("preview.loadingMessage")}
              downloadError={downloadError}
            />
          ) : unavailable ? (
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
              {previewLoading && <div className="preview-loading" role="status">{t("preview.loading")}</div>}
              {kind === "image" ? (
                <ImageViewer key={attempt} src={session!.contentUrl} alt={session!.filename} onReady={() => setState("ready")} onError={() => setState("error")} />
              ) : kind === "video" ? (
                <video key={attempt} src={session!.contentUrl} controls preload="metadata" onLoadedMetadata={() => setState("ready")} onError={() => setState("error")} />
              ) : kind === "audio" ? (
                <audio key={attempt} src={session!.contentUrl} controls preload="metadata" onCanPlay={() => setState("ready")} onError={() => setState("error")} />
              ) : kind === "document" && session!.modelUrl ? (
                <DocumentViewer key={attempt} nodeId={session!.nodeId} modelUrl={session!.modelUrl} mode={workspaceMode} onModeChange={setWorkspaceMode} onRegisterActions={registerWorkspaceActions} attempt={attempt} onReady={documentReady} onError={documentError} onDirtyChange={setDocumentDirty} />
              ) : kind === "spreadsheet" && session!.modelUrl ? (
                <SpreadsheetViewer key={attempt} nodeId={session!.nodeId} modelUrl={session!.modelUrl} mode={workspaceMode} onModeChange={setWorkspaceMode} onRegisterActions={registerWorkspaceActions} attempt={attempt} onReady={documentReady} onError={documentError} onDirtyChange={setDocumentDirty} />
              ) : kind === "presentation" && session!.modelUrl ? (
                <PresentationViewer key={attempt} nodeId={session!.nodeId} modelUrl={session!.modelUrl} mode={workspaceMode} onModeChange={setWorkspaceMode} onRegisterActions={registerWorkspaceActions} attempt={attempt} onReady={documentReady} onError={documentError} onDirtyChange={setDocumentDirty} />
              ) : kind === "text" && session!.modelUrl ? (
                <TextFileViewer key={attempt} nodeId={session!.nodeId} canEdit={Boolean(session!.capabilities?.edit)} modelUrl={session!.modelUrl} mode={workspaceMode} onModeChange={setWorkspaceMode} onRegisterActions={registerWorkspaceActions} attempt={attempt} onReady={documentReady} onError={documentError} onDirtyChange={setDocumentDirty} />
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
export default App;
