import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { OfficeFileKind, OfficeLocale } from '../office-template.service.js';

export class CreateOfficeFileDto {
  @IsEnum(OfficeFileKind)
  kind!: OfficeFileKind;

  @IsOptional()
  @IsEnum(OfficeLocale)
  locale?: OfficeLocale;

  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}
