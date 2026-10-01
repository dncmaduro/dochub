import {
  type ChangeEvent,
  type FormEvent,
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
  type DocumentRole,
  type EditorSession,
  type FileVersion,
  type Node,
  type PermissionEntry,
  type PermissionsState,
  type SharingPrincipal,
  type SharingState,
  type SystemRole,
  type TrashItem,
} from "./api";
import "./App.css";

const api = new ApiClient();
type Notice = { tone: "error" | "success"; message: string } | null;

function currentFolderId() {
  return (
    window.location.pathname.match(/^\/drive\/([0-9a-f-]+)$/i)?.[1] ?? null
  );
}
function currentRoute() {
  return window.location.pathname === "/trash" ? "trash" : "drive";
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
function displayError(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : "Something went wrong. Please try again.";
}
function hasCapability(node: Node, capability: string) {
  return node.capabilities.includes(capability);
}
function isOfficeFile(name: string) {
  return /\.(docx?|xlsx?|pptx?)$/i.test(name);
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

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [systemRole, setSystemRole] = useState<SystemRole | null>(null);
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    let active = true;
    void api.refresh().then(
      (session) => {
        if (!active) return;
        if (
          !/^(?:\/drive(?:\/[0-9a-f-]+)?|\/trash)$/i.test(
            window.location.pathname,
          )
        )
          window.history.replaceState({}, "", "/drive");
        setRoute(currentRoute());
        setSystemRole(session.systemRole);
        setAuthenticated(true);
      },
      () => active && setAuthenticated(false),
    );
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  if (authenticated === null)
    return <div className="auth-state">Checking your session…</div>;
  return authenticated ? (
    route === "trash" ? (
      <TrashApp />
    ) : (
      <DriveApp systemRole={systemRole!} />
    )
  ) : (
    <SignIn />
  );
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
  const [shareNode, setShareNode] = useState<Node | null>(null);
  const [trashNode, setTrashNode] = useState<Node | null>(null);
  const [versionNode, setVersionNode] = useState<Node | null>(null);
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
    try {
      if (isOfficeFile(node.name) && hasCapability(node, "PREVIEW")) {
        setEditor(await api.createEditorSession(node.id));
        return;
      }
      if (hasCapability(node, "DOWNLOAD")) await api.download(node);
    } catch (requestError) {
      setNotice({ tone: "error", message: displayError(requestError) });
    }
  }
  async function moveToTrash(node: Node) {
    await api.moveToTrash(node.id);
    setNodes((items) => items.filter((item) => item.id !== node.id));
    setNotice({ tone: "success", message: `Moved “${node.name}” to Trash.` });
  }
  const canPlaceAtRoot = systemRole === "ADMIN";
  const canCreateHere = folderId !== null || canPlaceAtRoot;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Icon name="drive" size={22} />
          <span>Docs Hub</span>
        </div>
        <nav aria-label="Main navigation">
          <button
            className="nav-item is-active"
            type="button"
            onClick={() => navigate(null)}
          >
            <Icon name="folder" />
            <span>Files</span>
          </button>
          <button className="nav-item" type="button" onClick={navigateTrash}>
            <Icon name="trash" />
            <span>Trash</span>
          </button>
        </nav>
      </aside>
      <main className="drive-main">
        <header className="topbar">
          <Breadcrumbs items={breadcrumbs} folderId={folderId} />
          <div className="toolbar-actions">
            <button
              type="button"
              className="button"
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
          </div>
        </header>
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
              onNotice={setNotice}
            />
          )}
        </section>
      </main>
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
        <EditorDialog session={editor} onClose={() => setEditor(null)} />
      )}
    </div>
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
  onNotice,
}: {
  nodes: Node[];
  onFolder: (id: string) => void;
  onRename: (node: Node) => void;
  onShare: (node: Node) => void;
  onTrash: (node: Node) => void;
  onVersions: (node: Node) => void;
  onOpen: (node: Node) => void;
  onNotice: (notice: Notice) => void;
}) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  return (
    <div className="file-table-wrap">
      <table className="file-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Modified</th>
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
              onNotice={onNotice}
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
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const isFolder = node.type === "FOLDER";
  const canOpen =
    isFolder ||
    (isOfficeFile(node.name) && hasCapability(node, "PREVIEW")) ||
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
          aria-label={`Actions for ${node.name}`}
          aria-expanded={menuOpen}
          onClick={onToggleMenu}
        >
          <Icon name="more" />
        </button>
        {menuOpen && (
          <RowMenu trigger={trigger} onClose={onCloseMenu}>
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
                : isOfficeFile(node.name) && hasCapability(node, "PREVIEW")
                  ? "Open"
                  : "Download"}
            </button>
            {!isFolder &&
              hasCapability(node, "DOWNLOAD") &&
              isOfficeFile(node.name) && (
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
  trigger,
  onClose,
  children,
}: {
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: -9999, left: -9999 });
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
    const closeForViewportChange = () => onClose();
    window.addEventListener("resize", closeForViewportChange);
    window.addEventListener("scroll", closeForViewportChange, true);
    return () => {
      window.removeEventListener("resize", closeForViewportChange);
      window.removeEventListener("scroll", closeForViewportChange, true);
    };
  }, [onClose, trigger]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as globalThis.Node) &&
        !trigger.current?.contains(event.target as globalThis.Node)
      )
        onClose();
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
  return createPortal(
    <div ref={menu} className="row-menu" role="menu" style={position}>
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
      <section className="dialog share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
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
        className="text-button"
        disabled={disabled}
        onClick={onRemove}
      >
        Remove
      </button>
    </div>
  );
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
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><Icon name="drive" size={22} /><span>Docs Hub</span></div>
        <nav aria-label="Main navigation">
          <button className="nav-item" type="button" onClick={() => navigate(null)}><Icon name="folder" /><span>Files</span></button>
          <button className="nav-item is-active" type="button" onClick={navigateTrash}><Icon name="trash" /><span>Trash</span></button>
        </nav>
      </aside>
      <main className="drive-main">
        <header className="topbar">
          <h1 className="page-title">Trash</h1>
          <div className="toolbar-actions"><button type="button" className="button" onClick={() => void load()} aria-label="Refresh Trash"><Icon name="refresh" /></button></div>
        </header>
        <section className="drive-content" aria-label="Trash">
          {status === "loading" && <LoadingRows />}
          {status === "error" && <ErrorState message={error} onRetry={() => void load()} />}
          {status === "ready" && items.length === 0 && <div className="content-state"><h1>Trash is empty.</h1></div>}
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
      </main>
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
    </div>
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
          aria-expanded={menuOpen}
          onClick={onToggleMenu}
        >
          <Icon name="more" />
        </button>
        {menuOpen && (
          <RowMenu trigger={trigger} onClose={onCloseMenu}>
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
      <section className="dialog version-dialog" role="dialog" aria-modal="true" aria-labelledby="version-dialog-title">
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
        className="dialog confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        <p>{message}</p>
        <div className="dialog-actions">
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
            className="button button-danger"
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending ? "Moving…" : action}
          </button>
        </div>
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
  useEffect(() => {
    input.current?.focus();
  }, []);
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
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="name-dialog-title"
      >
        <form onSubmit={submit}>
          <h2 id="name-dialog-title">{title}</h2>
          <label htmlFor="node-name">Name</label>
          <input
            id="node-name"
            ref={input}
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
      <Icon name="folder" size={30} />
      <h1>No files in this folder.</h1>
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
function LoadingRows() {
  return (
    <div className="loading-list" aria-label="Loading files">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}
function EditorDialog({
  session,
  onClose,
}: {
  session: EditorSession;
  onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let editor: { destroyEditor?: () => void } | undefined;
    let script: HTMLScriptElement | undefined;
    const start = () => {
      try {
        if (!window.DocsAPI || !container.current) throw new Error();
        editor = new window.DocsAPI.DocEditor(
          container.current.id,
          session.config,
        );
      } catch {
        setError("The document editor could not be opened.");
      }
    };
    if (window.DocsAPI) start();
    else {
      script = document.createElement("script");
      script.src = session.documentServer.apiUrl;
      script.async = true;
      script.onload = start;
      script.onerror = () => setError("The document editor is unavailable.");
      document.head.append(script);
    }
    return () => {
      editor?.destroyEditor?.();
      if (script) script.remove();
      void api.closeEditorSession(session.session.id).catch(() => undefined);
    };
  }, [session]);
  return (
    <div className="editor-backdrop">
      <section
        className="editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Document editor"
      >
        <header>
          <span>Document editor</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Close editor"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        {error ? (
          <div className="editor-error">{error}</div>
        ) : (
          <div
            id="onlyoffice-editor"
            ref={container}
            className="editor-frame"
          />
        )}
      </section>
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
