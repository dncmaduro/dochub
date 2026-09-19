export interface TempUpload {
  tempPath: string;
  originalFilename: string;
  declaredMimeType: string;
  sizeBytes: bigint;
  sha256: string;
  parentId: string | null;
}

export interface ValidatedUpload {
  originalFilename: string;
  nodeName: string;
  normalizedNodeName: string;
  extension: string;
  mimeType: string;
  sizeBytes: bigint;
  sha256: string;
}
