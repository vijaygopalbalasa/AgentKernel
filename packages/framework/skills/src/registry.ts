// Skill Registry — discovers and tracks available skills
// Like an app store for skills

import type {
  SkillId,
  SkillManifest,
  SkillRegistryEntry,
  SkillEvent,
} from "./types.js";
import { SkillManifestSchema } from "./types.js";

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
  private eventListeners: Array<(event: SkillEvent) => void> = [];

  /**
   * Register a skill manifest.
   */
  register(manifest: SkillManifest, source: string = "local"): boolean {
    // Validate manifest
    const validation = SkillManifestSchema.safeParse(manifest);
    if (!validation.success) {
      return false;
    }

    const entry: SkillRegistryEntry = {
      manifest,
      source,
      registeredAt: new Date(),
    };

    this.entries.set(manifest.id, entry);
    return true;
  }

  /**
   * Unregister a skill.
   */
  unregister(skillId: SkillId): boolean {
    return this.entries.delete(skillId);
  }

  /**
   * Get a skill entry.
   */
  get(skillId: SkillId): SkillRegistryEntry | null {
    return this.entries.get(skillId) ?? null;
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
  async fetchManifest(url: string): Promise<SkillManifest | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const validation = SkillManifestSchema.safeParse(data);

      if (!validation.success) {
        return null;
      }

      return validation.data as SkillManifest;
    } catch {
      return null;
    }
  }

  /**
   * Add a skill from a remote manifest URL.
   */
  async addFromUrl(url: string): Promise<boolean> {
    const manifest = await this.fetchManifest(url);
    if (!manifest) {
      return false;
    }

    return this.register(manifest, url);
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
  import(json: string): number {
    try {
      const data = JSON.parse(json) as Array<{
        manifest: SkillManifest;
        source: string;
      }>;

      let imported = 0;
      for (const item of data) {
        if (this.register(item.manifest, item.source)) {
          imported++;
        }
      }

      return imported;
    } catch {
      return 0;
    }
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
