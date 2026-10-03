import { rankLearnings } from './knowledge/retrieve.mjs';
import { readStoreConfig } from './knowledge/store.mjs';
import { runGate } from './gate.mjs';
import { indexStatus } from './index-status.mjs';
import { buildNeighborhood } from './repo-map/index.mjs';
import { pickActivePlan, listPlanRels } from './plan-parse.mjs';
import { readSession, writeSession } from './session.mjs';
import { findMatchingPlans } from './recall-rank.mjs';
import { discoverInventory, routingCards, workspaceRoutingRoots } from './route.mjs';

const INDEX_MISSING = { knowledge: 'missing', structural: 'missing' };

function indexPlane(plane) {
  if (!plane?.indexed) return 'missing';
  if (plane.unreadable?.length) return 'unreadable';
  if (plane.stale) return 'stale';
  return 'current';
}

export function readOrientSlice({ workspace, copilotHome, flags = {}, query = '', files } = {}) {
  const q = query || flags.query || '';
  const home = flags.harnessHome || flags.home;
  const namedFiles = Array.isArray(files) ? files : flags.files;
  if (String(q).trim() && !flags.dryRun) {
    const prior = readSession(workspace) || {};
    writeSession(workspace, {
      ...prior,
      lastQuery: q,
      files: Array.isArray(namedFiles) ? namedFiles : [],
    });
  }

  let learnings = [];
  try {
    const { mode } = readStoreConfig(workspace, { home });
    if (mode !== 'off' && mode !== 'capture-only') {
      learnings = rankLearnings({
        workspace,
        query: q,
        limit: flags.limit || 3,
        home,
        ...(Array.isArray(namedFiles) && namedFiles.length ? { signals: namedFiles } : {}),
      });
    }
  } catch {
    learnings = [];
  }

  const session = readSession(workspace) || {};
  let active = null;
  try {
    const matches = findMatchingPlans(workspace, q, flags.limit || 3);
    active = pickActivePlan(workspace, session, matches, listPlanRels(workspace));
  } catch {
    active = null;
  }

  let gateStatus = 'blocked';
  try {
    const gate = runGate({
      workspace,
      flags: { ...flags, phase: flags.phase || 'implement' },
      query: q,
    });
    gateStatus = gate.pass ? 'pass' : 'blocked';
  } catch {
    gateStatus = 'blocked';
  }

  let skills = [];
  let instructions = [];
  let contacts = [];
  if (active?.fm?.routing) {
    try {
      const inventory = discoverInventory(workspaceRoutingRoots(workspace, [copilotHome]));
      ({ skills, instructions, contacts } = routingCards(active.fm.routing, inventory));
    } catch {
      skills = [];
      instructions = [];
      contacts = [];
    }
  }

  let neighborhood = null;
  if (Array.isArray(namedFiles) && namedFiles.length) {
    try {
      neighborhood = buildNeighborhood({ workspace, files: namedFiles });
    } catch {
      neighborhood = null;
    }
  }

  let index = INDEX_MISSING;
  try {
    const status = indexStatus({ workspace, copilotHome, home });
    index = {
      knowledge: indexPlane(status.knowledge),
      structural: indexPlane(status.structural),
    };
  } catch {
    index = INDEX_MISSING;
  }

  return {
    neighborhood,
    learnings,
    skills,
    instructions,
    contacts,
    index,
    gateStatus,
    activePlan: active
      ? { path: active.path, status: active.status, plan_lock: active.plan_lock }
      : null,
  };
}
