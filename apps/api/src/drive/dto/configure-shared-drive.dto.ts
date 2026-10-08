import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ConfigureSharedDriveDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  sharedDriveId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  storageFolderId?: string;
}
