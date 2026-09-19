import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class NodeIdParamDto {
  @IsUUID()
  nodeId!: string;
}

export class CreateFolderDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}

export class RenameNodeDto {
  @IsString()
  @MaxLength(255)
  name!: string;
}

export class MoveNodeDto {
  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}

export class NodeListQueryDto {
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
