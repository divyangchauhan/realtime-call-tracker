import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * Request body for POST /calls.
 * The global ValidationPipe (whitelist: true) strips any extra properties.
 */
export class CreateCallDto {
  /** E.164 or display-format origination number/identifier. */
  @IsString()
  @IsNotEmpty()
  from!: string;

  /** E.164 or display-format destination number/identifier. */
  @IsString()
  @IsNotEmpty()
  to!: string;

  /** Arbitrary caller-supplied metadata forwarded into the call record. */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
