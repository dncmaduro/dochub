import { IsEnum, IsUUID } from 'class-validator';
import { GeneralAccessRole } from '@dochub/database';

export class SharingNodeParamDto {
  @IsUUID()
  nodeId!: string;
}

export class UpdateSharingDto {
  @IsEnum(GeneralAccessRole)
  generalAccessRole!: GeneralAccessRole;
}
