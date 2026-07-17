import { RuntimeError } from '../../shared/errors/Errors.js';
import type { JsonValue } from '../json/JsonValue.js';
import type { ArtifactRef } from './ArtifactRef.js';

export type PayloadLoader = (artifactId: number) => Promise<Uint8Array>;

// Immutable handle to an artifact. In workflow code it is reference-only; inside node bodies
// (activities) it gains payload access via an injected loader.
export class ArtifactHandle {
  constructor(
    readonly ref: ArtifactRef,
    private readonly loader?: PayloadLoader
  ) {}

  get artifactId(): number {
    return this.ref.artifact_id;
  }

  get hash(): string {
    return this.ref.hash;
  }

  get kind(): string {
    return this.ref.kind;
  }

  get label(): string {
    return this.ref.label ?? '';
  }

  get mediaType(): string {
    return this.ref.media_type ?? 'application/octet-stream';
  }

  async bytes(): Promise<Uint8Array> {
    if (this.loader === undefined) {
      throw new RuntimeError('payload access is only legal inside node bodies (activities), never in workflow code');
    }
    return this.loader(this.artifactId);
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }

  async json(): Promise<JsonValue> {
    const parsed: JsonValue = JSON.parse(await this.text());
    return parsed;
  }
}
