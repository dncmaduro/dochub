import { ConflictException, Injectable } from '@nestjs/common';
import type { DriveCreationTarget } from './drive.config.js';

@Injectable()
export class DriveCreationTargetService {
  resolve(integration: {
    sharedDriveId: string | null;
    storageFolderId: string | null;
  }): DriveCreationTarget {
    if (!integration.sharedDriveId) {
      throw new ConflictException(
        'A company Shared Drive must be configured before Drive writes are enabled.',
      );
    }
    return {
      type: 'SHARED_DRIVE',
      driveId: integration.sharedDriveId,
      // The Shared Drive id is also its root folder id. Always send an
      // explicit parent so Google cannot fall back to the operator's My Drive.
      parentFolderId: integration.storageFolderId ?? integration.sharedDriveId,
    };
  }
}
