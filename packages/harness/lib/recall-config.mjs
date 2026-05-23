import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export function resolveKnowledgePaths(copilotHome, workspace) {
  const candidates = [
    path.join(copilotHome, 'knowledge'),
    path.join(workspace, 'knowledge'),
  ].filter((p, i, arr) => fs.existsSync(p) && arr.indexOf(p) === i);

  return candidates;
}

function loadYamlFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const yaml = require('yaml');
    return yaml.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function loadRecallSynonyms(copilotHome, workspace) {
  for (const root of resolveKnowledgePaths(copilotHome, workspace)) {
    const doc = loadYamlFile(path.join(root, 'recall-synonyms.yaml'));
    if (doc?.synonyms) return doc.synonyms;
  }
  return {};
}

export function loadCollections(copilotHome, workspace) {
  for (const root of resolveKnowledgePaths(copilotHome, workspace)) {
    const doc = loadYamlFile(path.join(root, 'collections.yaml'));
    if (doc?.collections) return doc.collections;
  }
  return {};
}

export function expandQueryTokens(queryTokens, synonyms) {
  const expanded = new Set(queryTokens);
  for (const token of queryTokens) {
    const aliases = synonyms[token];
    if (!aliases) continue;
    for (const alias of aliases) {
      for (const t of alias.toLowerCase().split(/\s+/)) {
        if (t.length > 2) expanded.add(t);
      }
    }
  }
  return [...expanded];
}

export function entryMatchesCollection(entry, collectionName, collections) {
  if (!collectionName) return true;
  const spec = collections[collectionName];
  if (!spec) return true;

  if (spec.kinds?.length && !spec.kinds.includes(entry.kind)) return false;
  if (spec.scope && entry.scope !== spec.scope) return false;
  if (spec.scopes?.length && !spec.scopes.includes(entry.scope)) return false;
  if (spec.tags?.length) {
    const tags = entry.tags || [];
    if (!spec.tags.some((t) => tags.includes(t))) return false;
  }
  return true;
}

export function resolveIndexDir(copilotHome, workspace) {
  for (const root of resolveKnowledgePaths(copilotHome, workspace)) {
    return path.join(root, '.harness-index');
  }
  return path.join(workspace, 'knowledge', '.harness-index');
}

export function resolveManifestPath(copilotHome, workspace) {
  for (const root of resolveKnowledgePaths(copilotHome, workspace)) {
    const manifest = path.join(root, 'manifest.yaml');
    if (fs.existsSync(manifest)) return manifest;
  }
  return path.join(copilotHome, 'knowledge', 'manifest.yaml');
}
