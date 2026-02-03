// Skill Registry — discovers and tracks available skills
// Like an app store for skills

import { z } from "zod";
import { type Result, ok, err } from "@agent-os/shared";
import { type Logger, createLogger } from "@agent-os/kernel";
import type {
  SkillId,
  SkillManifest,
  SkillRegistryEntry,
} from "./types.js";
import { SkillManifestSchema, SkillError } from "./types.js";

/**
 * Skill Registry — manages discovery of available skills.
 *
 * Features:
 * - Register skills locally
 * - Fetch skill manifests from remote URLs
 * - Search and filter skills
 * - Track skill metadata
 */
export class SkillRegistry {
  private entries: Map<SkillId, SkillRegistryEntry> = new Map();
  private log: Logger;

  constructor() {
    this.log = createLogger({ name: "skill-registry" });
  }

  /**
   * Register a skill manifest.
   */
  register(manifest: SkillManifest, source: string = "local"): Result<SkillId, SkillError> {
    // Validate manifest
    const validation = SkillManifestSchema.safeParse(manifest);
    if (!validation.success) {
      this.log.warn("Invalid manifest in registry", {
        skillId: manifest.id,
        error: validation.error.message,
      });
      return err(
        new SkillError(
          `Invalid manifest: ${validation.error.message}`,
          "VALIDATION_ERROR",
          manifest.id
        )
      );
    }

    const entry: SkillRegistryEntry = {
      manifest,
      source,
      registeredAt: new Date(),
    };

    this.entries.set(manifest.id, entry);
    this.log.debug("Skill registered in registry", { skillId: manifest.id, source });
    return ok(manifest.id);
  }

  /**
   * Unregister a skill.
   */
  unregister(skillId: SkillId): Result<void, SkillError> {
    if (!this.entries.has(skillId)) {
      return err(
        new SkillError(`Skill not found in registry: ${skillId}`, "NOT_FOUND", skillId)
      );
    }
    this.entries.delete(skillId);
    this.log.debug("Skill unregistered from registry", { skillId });
    return ok(undefined);
  }

  /**
   * Get a skill entry.
   */
  get(skillId: SkillId): Result<SkillRegistryEntry, SkillError> {
    const entry = this.entries.get(skillId);
    if (!entry) {
      return err(
        new SkillError(`Skill not found in registry: ${skillId}`, "NOT_FOUND", skillId)
      );
    }
    return ok(entry);
  }

  /**
   * Check if a skill is registered.
   */
  has(skillId: SkillId): boolean {
    return this.entries.has(skillId);
  }

  /**
   * List all registered skills.
   */
  list(): SkillRegistryEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Find skills by category.
   */
  findByCategory(category: string): SkillRegistryEntry[] {
    return this.list().filter((e) =>
      e.manifest.categories?.includes(category)
    );
  }

  /**
   * Find skills by tag.
   */
  findByTag(tag: string): SkillRegistryEntry[] {
    return this.list().filter((e) => e.manifest.tags?.includes(tag));
  }

  /**
   * Find skills by author.
   */
  findByAuthor(author: string): SkillRegistryEntry[] {
    return this.list().filter((e) => e.manifest.author === author);
  }

  /**
   * Find skills by required permission.
   */
  findByPermission(permissionId: string): SkillRegistryEntry[] {
    return this.list().filter((e) =>
      e.manifest.permissions?.some((p) => p.id === permissionId)
    );
  }

  /**
   * Search skills by name or description.
   */
  search(query: string): SkillRegistryEntry[] {
    const q = query.toLowerCase();
    return this.list().filter(
      (e) =>
        e.manifest.name.toLowerCase().includes(q) ||
        e.manifest.description.toLowerCase().includes(q) ||
        e.manifest.tags?.some((t) => t.toLowerCase().includes(q))
    );
  }

  /**
   * Fetch a skill manifest from a URL.
   */
  async fetchManifest(url: string): Promise<Result<SkillManifest, SkillError>> {
    this.log.debug("Fetching manifest from URL", { url });

    try {
      const response = await fetch(url);
      if (!response.ok) {
        this.log.warn("Failed to fetch manifest", { url, status: response.status });
        return err(
          new SkillError(
            `Failed to fetch manifest: HTTP ${response.status}`,
            "FETCH_ERROR"
          )
        );
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch (e) {
        this.log.warn("Failed to parse manifest JSON", { url, error: e instanceof Error ? e.message : String(e) });
        return err(
          new SkillError(
            `Failed to parse manifest JSON: ${e instanceof Error ? e.message : String(e)}`,
            "PARSE_ERROR"
          )
        );
      }

      const validation = SkillManifestSchema.safeParse(data);
      if (!validation.success) {
        this.log.warn("Invalid manifest from URL", { url, error: validation.error.message });
        return err(
          new SkillError(
            `Invalid manifest: ${validation.error.message}`,
            "VALIDATION_ERROR"
          )
        );
      }

      this.log.debug("Successfully fetched manifest", { url, skillId: validation.data.id });
      return ok(validation.data as SkillManifest);
    } catch (e) {
      this.log.error("Error fetching manifest", { url, error: e instanceof Error ? e.message : String(e) });
      return err(
        new SkillError(
          `Failed to fetch manifest: ${e instanceof Error ? e.message : String(e)}`,
          "FETCH_ERROR"
        )
      );
    }
  }

  /**
   * Add a skill from a remote manifest URL.
   */
  async addFromUrl(url: string): Promise<Result<SkillId, SkillError>> {
    const manifestResult = await this.fetchManifest(url);
    if (!manifestResult.ok) {
      return manifestResult;
    }

    return this.register(manifestResult.value, url);
  }

  /**
   * Get statistics about registered skills.
   */
  getStats(): RegistryStats {
    const entries = this.list();
    const categories = new Set<string>();
    const tags = new Set<string>();
    const authors = new Set<string>();

    for (const entry of entries) {
      entry.manifest.categories?.forEach((c) => categories.add(c));
      entry.manifest.tags?.forEach((t) => tags.add(t));
      if (entry.manifest.author) {
        authors.add(entry.manifest.author);
      }
    }

    return {
      totalSkills: entries.length,
      categories: Array.from(categories),
      tags: Array.from(tags),
      authors: Array.from(authors),
    };
  }

  /**
   * Export the registry as JSON.
   */
  export(): string {
    const data = this.list().map((e) => ({
      manifest: e.manifest,
      source: e.source,
    }));
    return JSON.stringify(data, null, 2);
  }

  /**
   * Import skills from JSON.
   */
  import(json: string): Result<number, SkillError> {
    let data: Array<{ manifest: SkillManifest; source: string }>;
    try {
      data = JSON.parse(json) as Array<{
        manifest: SkillManifest;
        source: string;
      }>;
    } catch (e) {
      this.log.warn("Failed to parse import JSON", { error: e instanceof Error ? e.message : String(e) });
      return err(
        new SkillError(
          `Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`,
          "PARSE_ERROR"
        )
      );
    }

    let imported = 0;
    for (const item of data) {
      const result = this.register(item.manifest, item.source);
      if (result.ok) {
        imported++;
      }
    }

    this.log.info("Imported skills from JSON", { imported, total: data.length });
    return ok(imported);
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries.clear();
  }
}

/** Registry statistics */
export interface RegistryStats {
  totalSkills: number;
  categories: string[];
  tags: string[];
  authors: string[];
}

/** Create a new skill registry */
export function createSkillRegistry(): SkillRegistry {
  return new SkillRegistry();
}
