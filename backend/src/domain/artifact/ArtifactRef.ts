// The artifact reference dict that crosses every boundary: DB read models, Temporal payloads,
// activity transport, and the HTTP wire. Keys stay snake_case — this IS the wire shape.
export interface ArtifactRef {
  artifact_id: number;
  hash: string;
  nodeparamslot: string;
  display_name: string | null;
  media_type: string | null;
}
