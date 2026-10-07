import { Inject, Injectable } from '@nestjs/common';
import { DRIVE_CONFIG, type DriveConfig, type DriveCreationTarget } from './drive.config.js';

@Injectable()
export class DriveCreationTargetService {
  constructor(@Inject(DRIVE_CONFIG) private readonly config: DriveConfig) {}

  resolve(): DriveCreationTarget {
    return this.config.creationTarget;
  }
}
