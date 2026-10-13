import { describe, expect, it } from 'vitest';
import { acceptSavedModel, createEditorState, type DocumentEditorState } from '../../../web/src/document-editor/editor-state';
import type { DocumentModel } from '../../../web/src/api';

function model(storageRevision: string, text: string): DocumentModel {
  return {
    storageRevision,
    editable: true,
    blocks: [{ id: 'paragraph-1', type: 'paragraph', editable: true, content: [{ id: 'run-1', kind: 'text', text, bold: false, italic: false, underline: false, link: null }] }],
  } as unknown as DocumentModel;
}

describe('DOCX editor revision rebase', () => {
  it('rebases a clean successful save to the server revision', () => {
    const saved = acceptSavedModel(createEditorState(model('R1', 'A')), model('R2', 'A'));

    expect(saved.currentModel.storageRevision).toBe('R2');
    expect(saved.dirtyBlockIds.size).toBe(0);
    expect(saved.saveStatus).toBe('saved');
  });

  it('rebases while retaining edits made during the save', () => {
    const saving: DocumentEditorState = {
      ...createEditorState(model('R1', 'A')),
      currentModel: model('R1', 'AB'),
      dirtyBlockIds: new Set(['paragraph-1']),
      saveStatus: 'saving',
    };
    const saved = acceptSavedModel(saving, model('R2', 'A'));

    expect(saved.currentModel.storageRevision).toBe('R2');
    expect(saved.currentModel.blocks).toEqual(saving.currentModel.blocks);
    expect(saved.dirtyBlockIds).toEqual(new Set(['paragraph-1']));
    expect(saved.saveStatus).toBe('unsaved');
  });
});
