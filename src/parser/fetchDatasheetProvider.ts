/**
 * Real `DatasheetProvider` implementation for the browser app: fetches the
 * normalized JSON written by scripts/fetch-and-parse-data.mjs to public/data/.
 * Not used by tests (see parseArmyList.test.ts for the in-memory fixture
 * provider) — kept intentionally tiny and network-only so it never needs
 * mocking.
 */

import type { DataManifest, DatasheetProvider, NormalizedFactionFile } from "./types";

export function createFetchDatasheetProvider(baseUrl = "/data"): DatasheetProvider {
  let manifestPromise: Promise<DataManifest> | null = null;
  const factionCache = new Map<string, Promise<NormalizedFactionFile>>();

  return {
    getManifest() {
      if (!manifestPromise) {
        manifestPromise = fetch(`${baseUrl}/index.json`).then((res) => {
          if (!res.ok) throw new Error(`Failed to load ${baseUrl}/index.json: ${res.status}`);
          return res.json() as Promise<DataManifest>;
        });
      }
      return manifestPromise;
    },
    loadFaction(slug: string) {
      let promise = factionCache.get(slug);
      if (!promise) {
        promise = fetch(`${baseUrl}/${slug}.json`).then((res) => {
          if (!res.ok) throw new Error(`Failed to load ${baseUrl}/${slug}.json: ${res.status}`);
          return res.json() as Promise<NormalizedFactionFile>;
        });
        factionCache.set(slug, promise);
      }
      return promise;
    },
  };
}
