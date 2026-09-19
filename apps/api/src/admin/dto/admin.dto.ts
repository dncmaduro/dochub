import { Type } from 'class-transformer';
import {
  IsEnum,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SystemRole, UserStatus } from '@dochub/database';

export class UserIdParamDto {
  @IsUUID()
  userId!: string;
}

export class GroupIdParamDto {
  @IsUUID()
  groupId!: string;
}

export class GroupMemberParamDto extends GroupIdParamDto {
  @IsUUID()
  userId!: string;
}

export class CursorPaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class ListUsersQueryDto extends CursorPaginationDto {
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsEnum(SystemRole)
  systemRole?: SystemRole;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

export class CreateUserDto {
  @IsString()
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(320)
  email!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  displayName!: string;

  @IsOptional()
  @IsEnum(SystemRole)
  systemRole?: SystemRole;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsEnum(SystemRole)
  systemRole?: SystemRole;

  @IsOptional()
  @IsIn([UserStatus.ACTIVE, UserStatus.SUSPENDED])
  status?: 'ACTIVE' | 'SUSPENDED';
}

export class CreateGroupDto {
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class UpdateGroupDto {
  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class AddGroupMemberDto {
  @IsUUID()
  userId!: string;
}
