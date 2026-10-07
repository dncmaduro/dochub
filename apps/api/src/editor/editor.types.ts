export const OFFICE_DOCUMENT_TYPES = Object.freeze({
  doc: 'word', docx: 'word', xls: 'cell', xlsx: 'cell', ppt: 'slide', pptx: 'slide',
} as const);

export type OfficeExtension = keyof typeof OFFICE_DOCUMENT_TYPES;

export function officeDocumentType(extension: string): (typeof OFFICE_DOCUMENT_TYPES)[OfficeExtension] | undefined {
  return OFFICE_DOCUMENT_TYPES[extension.trim().replace(/^\./, '').toLowerCase() as OfficeExtension];
}

export function fileExtension(filename: string, extension: string | null): string {
  if (extension?.trim()) return extension.trim().replace(/^\./, '').toLowerCase();
  const index = filename.lastIndexOf('.');
  return index === -1 ? '' : filename.slice(index + 1).toLowerCase();
}

export function onlyOfficeAccessConfig(mode: 'VIEW' | 'EDIT') {
  const editable = mode === 'EDIT';
  return {
    editorConfigMode: editable ? ('edit' as const) : ('view' as const),
    documentPermissions: {
      edit: editable,
      comment: editable,
    },
  };
}

export function editorVersionAttribution(
  sessions: Array<{
    actorType: EditorActorType;
    userId: string | null;
    mode: 'VIEW' | 'EDIT';
  }>,
): { actorType: FileVersionActorType; createdById: string | null } {
  const editors = sessions.filter((session) => session.mode === 'EDIT');
  const userIds = [
    ...new Set(
      editors
        .filter(
          (session) =>
            session.actorType === EditorActorType.USER && session.userId,
        )
        .map((session) => session.userId as string),
    ),
  ];
  const hasPublic = editors.some(
    (session) => session.actorType === EditorActorType.PUBLIC,
  );
  if (userIds.length === 1 && !hasPublic) {
    return { actorType: FileVersionActorType.USER, createdById: userIds[0] };
  }
  if (userIds.length === 0) {
    return { actorType: FileVersionActorType.PUBLIC, createdById: null };
  }
  return { actorType: FileVersionActorType.COLLABORATIVE, createdById: null };
}
import { EditorActorType, FileVersionActorType } from '@dochub/database';
