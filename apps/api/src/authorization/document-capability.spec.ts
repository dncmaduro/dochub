import { DocumentRole } from '@dochub/database';
import {
  DOCUMENT_ROLE_CAPABILITIES,
  DocumentCapability,
} from './document-capability.js';

describe('DOCUMENT_ROLE_CAPABILITIES', () => {
  it('maps each document role to its exact capabilities', () => {
    expect(DOCUMENT_ROLE_CAPABILITIES[DocumentRole.VIEWER]).toEqual([
      DocumentCapability.VIEW,
      DocumentCapability.PREVIEW,
      DocumentCapability.DOWNLOAD,
    ]);
    expect(DOCUMENT_ROLE_CAPABILITIES[DocumentRole.EDITOR]).toEqual([
      DocumentCapability.VIEW,
      DocumentCapability.PREVIEW,
      DocumentCapability.DOWNLOAD,
      DocumentCapability.CREATE,
      DocumentCapability.EDIT,
      DocumentCapability.RENAME,
      DocumentCapability.MOVE,
      DocumentCapability.DELETE,
      DocumentCapability.RESTORE_VERSION,
    ]);
    expect(DOCUMENT_ROLE_CAPABILITIES[DocumentRole.OWNER]).toEqual([
      DocumentCapability.VIEW,
      DocumentCapability.PREVIEW,
      DocumentCapability.DOWNLOAD,
      DocumentCapability.CREATE,
      DocumentCapability.EDIT,
      DocumentCapability.RENAME,
      DocumentCapability.MOVE,
      DocumentCapability.DELETE,
      DocumentCapability.RESTORE_VERSION,
      DocumentCapability.SHARE,
      DocumentCapability.MANAGE_PERMISSION,
    ]);
  });
});
