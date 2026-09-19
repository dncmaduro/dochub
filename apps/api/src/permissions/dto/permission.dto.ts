import { IsBoolean, IsEnum, IsUUID } from 'class-validator';
import { DocumentRole } from '@dochub/database';

export class NodePermissionParamDto {
  @IsUUID()
  nodeId!: string;
}

export class NodeUserPermissionParamDto extends NodePermissionParamDto {
  @IsUUID()
  userId!: string;
}

export class NodeGroupPermissionParamDto extends NodePermissionParamDto {
  @IsUUID()
  groupId!: string;
}

export class SetPermissionRoleDto {
  @IsEnum(DocumentRole)
  role!: DocumentRole;
}

export class UpdatePermissionSettingsDto {
  @IsBoolean()
  inheritPermissions!: boolean;
}
