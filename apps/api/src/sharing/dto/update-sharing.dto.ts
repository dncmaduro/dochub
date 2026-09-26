import { IsBoolean, IsUUID } from 'class-validator';

export class SharingNodeParamDto {
  @IsUUID()
  nodeId!: string;
}

export class UpdateSharingDto {
  @IsBoolean()
  publicAccess!: boolean;
}
