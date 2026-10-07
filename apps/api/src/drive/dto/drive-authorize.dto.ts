import { IsIn, IsOptional } from 'class-validator';

export class DriveAuthorizeDto {
  @IsOptional()
  @IsIn(['WRITE'])
  mode?: 'WRITE';
}
