// AgentRun Package Manager — Install, uninstall, list, and update agents
// Like apt/npm but for AgentRun agents.

import chalk from "chalk";
import ora from "ora";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { AgentManifestSchema } from "@agentrun/sdk";

interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  source: string;
  sourceType: "local" | "npm" | "git";
  installedAt: string;
  entryPoint?: string;
}

interface Catalog {
  version: 1;
  agents: CatalogEntry[];
}

function getAgentsDir(): string {
  return resolve(process.cwd(), "agents");
}

function getCatalogPath(): string {
  return join(getAgentsDir(), ".catalog.json");
}

function loadCatalog(): Catalog {
  const path = getCatalogPath();
  if (!existsSync(path)) {
    return { version: 1, agents: [] };
  }
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content) as Catalog;
}

function saveCatalog(catalog: Catalog): void {
  const dir = getAgentsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getCatalogPath(), JSON.stringify(catalog, null, 2));
}

function detectSourceType(source: string): "local" | "npm" | "git" {
  if (source.startsWith("./") || source.startsWith("/") || source.startsWith("../")) {
    return "local";
  }
  if (source.startsWith("github:") || source.startsWith("git:") || source.endsWith(".git")) {
    return "git";
  }
  return "npm";
}

function upsertCatalogEntry(catalog: Catalog, entry: CatalogEntry): void {
  const existing = catalog.agents.findIndex((a) => a.id === entry.id);
  if (existing >= 0) {
    catalog.agents[existing] = entry;
  } else {
    catalog.agents.push(entry);
  }
}

function buildAgent(agentDir: string, spinner: ReturnType<typeof ora>): void {
  try {
    execFileSync("pnpm", ["install"], { cwd: agentDir, stdio: "pipe" });
    execFileSync("pnpm", ["build"], { cwd: agentDir, stdio: "pipe" });
  } catch {
    spinner.text += chalk.gray(" (build skipped)");
  }
}

/**
 * Install an agent from a source (local path, npm package, or git repo).
 */
export async function installAgent(source: string): Promise<void> {
  const spinner = ora(`Installing agent from ${source}...`).start();

  try {
    const sourceType = detectSourceType(source);

    if (sourceType === "local") {
      const sourcePath = resolve(process.cwd(), source);
      if (!existsSync(sourcePath)) {
        throw new Error(`Source directory not found: ${sourcePath}`);
      }

      const manifestPath = join(sourcePath, "manifest.json");
      if (!existsSync(manifestPath)) {
        throw new Error(`No manifest.json found in ${sourcePath}`);
      }

      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const validation = AgentManifestSchema.safeParse(manifest);
      if (!validation.success) {
        throw new Error(`Invalid manifest: ${validation.error.message}`);
      }

      const agentId = validation.data.id;
      const agentDir = join(getAgentsDir(), agentId);

      if (resolve(sourcePath) !== resolve(agentDir)) {
        if (existsSync(agentDir)) {
          rmSync(agentDir, { recursive: true, force: true });
        }
        spinner.text = `Copying agent ${agentId}...`;
        cpSync(sourcePath, agentDir, { recursive: true });
      }

      spinner.text = `Building ${agentId}...`;
      buildAgent(agentDir, spinner);

      const catalog = loadCatalog();
      upsertCatalogEntry(catalog, {
        id: agentId,
        name: validation.data.name,
        version: validation.data.version,
        source: resolve(sourcePath),
        sourceType: "local",
        installedAt: new Date().toISOString(),
        entryPoint: validation.data.entryPoint,
      });
      saveCatalog(catalog);

      spinner.succeed(chalk.green(`Installed ${agentId} v${validation.data.version} from local path`));
      return;
    }

    if (sourceType === "npm") {
      spinner.text = `Fetching ${source} from npm...`;
      const tmpDir = join(getAgentsDir(), ".tmp-install");
      mkdirSync(tmpDir, { recursive: true });

      try {
        execFileSync("npm", ["pack", source, "--pack-destination", tmpDir], {
          cwd: tmpDir,
          stdio: "pipe",
        });

        // Find the tarball
        const tarballs = readdirSync(tmpDir).filter((f) => f.endsWith(".tgz"));
        if (tarballs.length === 0) {
          throw new Error("npm pack produced no output");
        }

        const tarballPath = join(tmpDir, tarballs[0]);
        execFileSync("tar", ["-xzf", tarballPath, "-C", tmpDir], { stdio: "pipe" });

        const packageDir = join(tmpDir, "package");
        const manifestPath = join(packageDir, "manifest.json");
        if (!existsSync(manifestPath)) {
          throw new Error(`No manifest.json in npm package ${source}`);
        }

        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const validation = AgentManifestSchema.safeParse(manifest);
        if (!validation.success) {
          throw new Error(`Invalid manifest in ${source}: ${validation.error.message}`);
        }

        const agentId = validation.data.id;
        const agentDir = join(getAgentsDir(), agentId);

        if (existsSync(agentDir)) {
          rmSync(agentDir, { recursive: true, force: true });
        }
        cpSync(packageDir, agentDir, { recursive: true });

        spinner.text = `Building ${agentId}...`;
        buildAgent(agentDir, spinner);

        const catalog = loadCatalog();
        upsertCatalogEntry(catalog, {
          id: agentId,
          name: validation.data.name,
          version: validation.data.version,
          source,
          sourceType: "npm",
          installedAt: new Date().toISOString(),
          entryPoint: validation.data.entryPoint,
        });
        saveCatalog(catalog);

        spinner.succeed(chalk.green(`Installed ${agentId} v${validation.data.version} from npm`));
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      return;
    }

    if (sourceType === "git") {
      spinner.text = `Cloning ${source}...`;
      const gitUrl = source.startsWith("github:")
        ? `https://github.com/${source.slice(7)}.git`
        : source;

      const tmpDir = join(getAgentsDir(), ".tmp-git");
      rmSync(tmpDir, { recursive: true, force: true });

      execFileSync("git", ["clone", "--depth", "1", gitUrl, tmpDir], { stdio: "pipe" });

      const manifestPath = join(tmpDir, "manifest.json");
      if (!existsSync(manifestPath)) {
        rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(`No manifest.json in git repo ${source}`);
      }

      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const validation = AgentManifestSchema.safeParse(manifest);
      if (!validation.success) {
        rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(`Invalid manifest in ${source}: ${validation.error.message}`);
      }

      const agentId = validation.data.id;
      const agentDir = join(getAgentsDir(), agentId);

      if (existsSync(agentDir)) {
        rmSync(agentDir, { recursive: true, force: true });
      }
      cpSync(tmpDir, agentDir, { recursive: true });
      rmSync(tmpDir, { recursive: true, force: true });

      spinner.text = `Building ${agentId}...`;
      buildAgent(agentDir, spinner);

      const catalog = loadCatalog();
      upsertCatalogEntry(catalog, {
        id: agentId,
        name: validation.data.name,
        version: validation.data.version,
        source,
        sourceType: "git",
        installedAt: new Date().toISOString(),
        entryPoint: validation.data.entryPoint,
      });
      saveCatalog(catalog);

      spinner.succeed(chalk.green(`Installed ${agentId} v${validation.data.version} from git`));
      return;
    }
  } catch (error) {
    spinner.fail(chalk.red(`Install failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

/**
 * Uninstall an agent by ID.
 */
export async function uninstallAgent(agentId: string): Promise<void> {
  const spinner = ora(`Uninstalling agent ${agentId}...`).start();

  try {
    const catalog = loadCatalog();
    const idx = catalog.agents.findIndex((a) => a.id === agentId);

    if (idx < 0) {
      spinner.fail(chalk.red(`Agent ${agentId} not found in catalog`));
      return;
    }

    const agentDir = join(getAgentsDir(), agentId);
    if (existsSync(agentDir)) {
      rmSync(agentDir, { recursive: true, force: true });
    }

    catalog.agents.splice(idx, 1);
    saveCatalog(catalog);

    spinner.succeed(chalk.green(`Uninstalled agent ${agentId}`));
  } catch (error) {
    spinner.fail(chalk.red(`Uninstall failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

/**
 * List all installed agents.
 */
export function listAgents(): void {
  const catalog = loadCatalog();

  if (catalog.agents.length === 0) {
    console.log(chalk.gray("No agents installed. Use 'agentrun install <source>' to install one."));
    return;
  }

  console.log(chalk.bold(`\n${catalog.agents.length} agent(s) installed:\n`));
  console.log(
    chalk.gray("  ID".padEnd(20)) +
    chalk.gray("VERSION".padEnd(10)) +
    chalk.gray("SOURCE".padEnd(12)) +
    chalk.gray("NAME")
  );
  console.log(chalk.gray("  " + "─".repeat(60)));

  for (const agent of catalog.agents) {
    console.log(
      `  ${chalk.cyan(agent.id.padEnd(20))}` +
      `${chalk.white(agent.version.padEnd(10))}` +
      `${chalk.yellow(agent.sourceType.padEnd(12))}` +
      `${chalk.gray(agent.name)}`
    );
  }
  console.log();
}

/**
 * Update an agent by re-fetching from its original source.
 */
export async function updateAgent(agentId: string): Promise<void> {
  const catalog = loadCatalog();
  const entry = catalog.agents.find((a) => a.id === agentId);

  if (!entry) {
    console.log(chalk.red(`Agent ${agentId} not found in catalog`));
    process.exit(1);
  }

  console.log(chalk.gray(`Updating ${agentId} from ${entry.source}...`));
  await installAgent(entry.source);
}
