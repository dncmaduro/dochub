import {
  FileProcessingTaskStatus,
  isSearchableFileMimeType,
} from '@dochub/database';

export type ProcessingStatus = 'READY' | 'PROCESSING' | 'FAILED';

/** User-facing state for the only processing pipeline that currently exists. */
export function contentSearchStatus(
  version:
    | { mimeType: string; processingTasks: Array<{ status: FileProcessingTaskStatus }> }
    | null
    | undefined,
): ProcessingStatus | null {
  if (!version || !isSearchableFileMimeType(version.mimeType)) return null;
  const status = version.processingTasks[0]?.status;
  if (status === FileProcessingTaskStatus.FAILED) return 'FAILED';
  if (status === FileProcessingTaskStatus.COMPLETED) return 'READY';
  return 'PROCESSING';
}
