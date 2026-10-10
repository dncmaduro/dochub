import { ConflictException, Injectable } from '@nestjs/common';
import type { DriveCreationTarget } from './drive.config.js';

@Injectable()
export class DriveCreationTargetService {
  resolve(integration: {
    storageFolderId: string | null;
  }): DriveCreationTarget {
    if (!integration.storageFolderId) {
      throw new ConflictException(
        'A company Google Drive storage folder must be configured before Drive writes are enabled.',
      );
    }
    return {
      type: 'DRIVE_FOLDER',
      parentFolderId: integration.storageFolderId,
    };
  }
}
