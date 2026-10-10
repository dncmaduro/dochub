import { IsString, MaxLength, MinLength } from 'class-validator';

export class ConfigureStorageFolderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  storageFolderId!: string;
}
