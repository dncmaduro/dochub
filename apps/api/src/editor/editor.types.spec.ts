import { describe, expect, it } from 'vitest';
import { EditorActorType, FileVersionActorType } from '@dochub/database';
import {
  editorVersionAttribution,
  fileExtension,
  officeDocumentType,
  onlyOfficeAccessConfig,
} from './editor.types.js';

describe('ONLYOFFICE document mapping', () => {
  it.each([
    ['DOC', 'word'],
    ['docx', 'word'],
    ['XLS', 'cell'],
    ['xlsx', 'cell'],
    ['PPT', 'slide'],
    ['pptx', 'slide'],
  ])('maps %s to %s', (extension, type) => {
    expect(officeDocumentType(extension)).toBe(type);
  });

  it('normalizes filename extensions and rejects unsupported types', () => {
    expect(fileExtension('Report.DOCX', null)).toBe('docx');
    expect(fileExtension('ignored.pdf', '.XLSX')).toBe('xlsx');
    expect(officeDocumentType('pdf')).toBeUndefined();
  });
});

describe('ONLYOFFICE access config', () => {
  it.each([
    ['VIEWER', 'VIEW', false, 'view'],
    ['EDITOR', 'EDIT', true, 'edit'],
    ['OWNER', 'EDIT', true, 'edit'],
    ['PUBLIC VIEWER', 'VIEW', false, 'view'],
    ['PUBLIC EDITOR', 'EDIT', true, 'edit'],
  ] as const)('%s emits the policy permissions', (_role, mode, edit, editorMode) => {
    expect(onlyOfficeAccessConfig(mode)).toEqual({
      editorConfigMode: editorMode,
      documentPermissions: {
        edit,
        comment: edit,
      },
    });
  });
});

describe('ONLYOFFICE version attribution', () => {
  it('keeps one authenticated editor as the version actor', () => {
    expect(
      editorVersionAttribution([
        { actorType: EditorActorType.USER, userId: 'user-a', mode: 'EDIT' },
        { actorType: EditorActorType.USER, userId: 'user-a', mode: 'EDIT' },
      ]),
    ).toEqual({ actorType: FileVersionActorType.USER, createdById: 'user-a' });
  });

  it('does not select an arbitrary callback participant for collaboration', () => {
    expect(
      editorVersionAttribution([
        { actorType: EditorActorType.USER, userId: 'user-a', mode: 'EDIT' },
        { actorType: EditorActorType.USER, userId: 'user-b', mode: 'EDIT' },
      ]),
    ).toEqual({
      actorType: FileVersionActorType.COLLABORATIVE,
      createdById: null,
    });
  });

  it('keeps anonymous-only generations as public', () => {
    expect(
      editorVersionAttribution([
        { actorType: EditorActorType.PUBLIC, userId: null, mode: 'EDIT' },
        { actorType: EditorActorType.PUBLIC, userId: null, mode: 'EDIT' },
      ]),
    ).toEqual({ actorType: FileVersionActorType.PUBLIC, createdById: null });
  });
});
