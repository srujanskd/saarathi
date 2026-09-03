import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEDIA_TYPES, type MediaItem, type MediaMime } from "@saarathi/shared";

export interface MediaFiles {
  put(id: string, mime: MediaMime, data: Buffer): void;
  remove(item: MediaItem): void;
  exists(item: MediaItem): boolean;
  path(item: MediaItem): string;
}

/** Files beside state.json, under the same app-data directory Electron owns. */
export class DiskMediaFiles implements MediaFiles {
  constructor(private readonly directory: string) {}

  put(id: string, mime: MediaMime, data: Buffer): void {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.pathFor(id, mime), data, { flag: "wx", mode: 0o600 });
  }

  remove(item: MediaItem): void {
    rmSync(this.path(item), { force: true });
  }

  exists(item: MediaItem): boolean {
    return existsSync(this.path(item));
  }

  path(item: MediaItem): string {
    return this.pathFor(item.id, item.mime);
  }

  private pathFor(id: string, mime: MediaMime): string {
    // Both parts came from us: UUID id and the closed MIME table. The original
    // filename never becomes a path, so there is no traversal to sanitize.
    return join(this.directory, `${id}.${MEDIA_TYPES[mime].extension}`);
  }
}
