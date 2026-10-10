import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DriveFoldersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
