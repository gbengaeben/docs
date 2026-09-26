#!/usr/bin/env node
/**
 * check-contract-registry.mjs
 *
 * Enforces the canonical Wraith contract registry defined in
 * scripts/contract-registry.json. Run it after editing any page that mentions a
 * contract address, or after bumping @wraith-protocol/sdk:
 *
 *   node scripts/check-contract-registry.mjs
 *
 * It fails the build when:
 *   1. The registry is malformed or an address is not a valid contract id.
 *   2. A shipped .mdx page still carries a stale placeholder contract id.
 *   3. A deployed registry address is not documented anywhere.
 *   4. The network guide, SDK, quickstart (demo), or contracts page stopped
 *      linking to the canonical registry.
 *
 * Wired into CI via the "Compile docs snippets" job in
 * .github/workflows/snippets.yml.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const registryPath = path.join(repoRoot, "scripts", "contract-registry.json");

/** Top-level directories whose pages ship in the navigation. */
const shippedDirs = ["api-reference", "architecture", "contracts", "guides", "reference", "sdk"];

/** Pages that must link to the canonical registry. */
const requiredRegistryLinks = [
  "reference/stellar-networks.mdx",
  "guides/stellar-mainnet-deployment.mdx",
  "contracts/stellar.mdx",
  "sdk/chains/stellar.mdx",
  "guides/stellar/stellar-quickstart.mdx",
];

/** A Stellar contract id: "C" followed by 55 base-32 characters. */
const STELLAR_CONTRACT_ID = /^C[A-Z2-7]{55}$/;

/** Stale placeholder contract ids that must never ship again. */
const bannedPatterns = [
  { pattern: /CPLACEHOLDER[_A-Z0-9]*/g, label: "stale CPLACEHOLDER contract id" },
  { pattern: /\bC\[TBD[^\]]*\]/g, label: "C[TBD] contract id placeholder" },
  { pattern: /\bG\[TBD[^\]]*\]/g, label: "G[TBD] account placeholder" },
  { pattern: /\b0xPLACEHOLDER[A-Za-z0-9]*/g, label: "0xPLACEHOLDER address" },
  { pattern: /<STELLAR_[A-Z_]*CONTRACT_ID>/g, label: "unresolved STELLAR_*_CONTRACT_ID placeholder" },
];

const registryPage = "reference/contract-registry";

async function main() {
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const failures = [];

  const deployedAddresses = validateRegistry(registry, failures);

  const pages = await collectPages();
  const offenders = [];
  const pagesWithLinks = new Set();

  for (const page of pages) {
    const source = await readFile(path.join(repoRoot, page), "utf8");

    for (const { pattern, label } of bannedPatterns) {
      const matches = [...source.matchAll(pattern)];
      if (matches.length > 0) {
        const lines = matches.map((match) => lineNumberAt(source, match.index)).join(", ");
        offenders.push(`  - ${page} (${label}) line ${lines}`);
      }
    }

    if (source.includes(`/${registryPage}`) || source.includes(registryPage)) {
      pagesWithLinks.add(page);
    }
  }

  if (offenders.length > 0) {
    failures.push(
      [
        "Shipped pages contain stale contract placeholders. Replace them with the",
        "canonical values from scripts/contract-registry.json:",
        ...offenders,
      ].join("\n"),
    );
  }

  const allSource = (
    await Promise.all(pages.map((page) => readFile(path.join(repoRoot, page), "utf8")))
  ).join("\n");
  const missingAddresses = [...deployedAddresses].filter((address) => !allSource.includes(address));
  if (missingAddresses.length > 0) {
    failures.push(
      [
        "Deployed contracts are not documented anywhere in the shipped pages:",
        ...missingAddresses.map((address) => `  - ${address}`),
      ].join("\n"),
    );
  }

  const missingLinks = requiredRegistryLinks.filter((page) => !pagesWithLinks.has(page));
  if (missingLinks.length > 0) {
    failures.push(
      [
        "These pages must link to the canonical registry (/reference/contract-registry):",
        ...missingLinks.map((page) => `  - ${page}`),
      ].join("\n"),
    );
  }

  if (failures.length > 0) {
    console.error(
      [
        "Contract registry check failed.",
        "",
        ...failures,
        "",
        "The registry is the single source of truth: update scripts/contract-registry.json",
        "first, then update the pages that reference it.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `Contract registry check passed: ${deployedAddresses.size} deployed contract(s) verified ` +
      `across ${Object.keys(registry.networks).length} networks, ${pages.length} shipped pages scanned.`,
  );
}

/** Validate the registry shape and return the set of deployed contract ids. */
function validateRegistry(registry, failures) {
  const deployed = new Set();
  const networks = registry.networks;

  if (!networks || typeof networks !== "object" || Object.keys(networks).length === 0) {
    failures.push("scripts/contract-registry.json has no networks.");
    return deployed;
  }

  for (const [networkKey, network] of Object.entries(networks)) {
    for (const field of ["label", "network", "passphrase", "status", "explorerBase", "contracts"]) {
      if (network[field] === undefined || network[field] === null) {
        failures.push(`scripts/contract-registry.json: ${networkKey} is missing "${field}".`);
      }
    }

    for (const [contractKey, contract] of Object.entries(network.contracts ?? {})) {
      const where = `${networkKey}/${contractKey}`;
      if (contract.address === null) {
        if (contract.artifactHash !== null || contract.deploymentLedger !== null) {
          failures.push(`scripts/contract-registry.json: ${where} has artifact metadata without an address.`);
        }
        continue;
      }

      if (typeof contract.address !== "string" || !STELLAR_CONTRACT_ID.test(contract.address)) {
        failures.push(`scripts/contract-registry.json: ${where} has an invalid Stellar contract id.`);
        continue;
      }
      if (!/^[0-9a-f]{64}$/.test(contract.artifactHash ?? "")) {
        failures.push(`scripts/contract-registry.json: ${where} needs a 64-char lowercase artifact hash.`);
      }
      if (!Number.isInteger(contract.deploymentLedger)) {
        failures.push(`scripts/contract-registry.json: ${where} needs a deployment ledger.`);
      }
      if (typeof contract.version !== "string" || contract.version.length === 0) {
        failures.push(`scripts/contract-registry.json: ${where} needs a version.`);
      }
      deployed.add(contract.address);
    }
  }

  return deployed;
}

/** Collect the nav path of every shipped .mdx page (directories + repo root). */
async function collectPages() {
  const pages = [];

  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Directory does not exist.
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
        pages.push(toPagePath(fullPath));
      }
    }
  };

  for (const dir of shippedDirs) {
    await walk(path.join(repoRoot, dir));
  }

  const rootEntries = await readdir(repoRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.endsWith(".mdx")) {
      pages.push(entry.name);
    }
  }

  return pages.sort();
}

function toPagePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
