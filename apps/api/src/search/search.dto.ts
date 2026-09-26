import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { NodeType } from '@dochub/database';

export class SearchQueryDto {
  @IsString() @MaxLength(200) q!: string;
  @IsOptional() @IsEnum(NodeType) type?: NodeType;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @IsString() cursor?: string;
}
