import { readFileNoFollow } from './fs-safe.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { extractAcceptanceCriteria } from './plan-schema.mjs';
import { validatePlaybookBinding } from './playbook-binding.mjs';
import { planHome } from './domain-context.mjs';
import { domainLinkCheck } from './domain-delivery.mjs';
import { sharedIntentCheck } from './domain-bindings.mjs';
import { hashIntentFile } from './intent-sources.mjs';

import { projectAuthorityFile } from './project-authority.mjs';

function result(id, pass, message) {
  return { id, pass, message };
}

export function gapEvidenceCheck(workspace, plan) {
  const bound = (plan.fm.capability_gaps || []).filter(gap => gap?.evidence_binding !== undefined || gap?.evidence && typeof gap.evidence === 'object' && !Array.isArray(gap.evidence));
  const stale = bound.filter(gap => {
    const binding = gap.evidence_binding ?? gap.evidence;
    return typeof binding?.path !== 'string' || !/^[a-f0-9]{64}$/.test(binding?.sha256 || '') || hashIntentFile(workspace, binding.path) !== binding.sha256;
  });
  return result('gap-evidence', !stale.length, stale.length ? `Capability gap evidence changed or is unavailable: ${stale.map(gap => gap.id).join(', ')}` : `${bound.length} capability gap evidence bindings are current`);
}

export function loadConfiguredChecks(workspace, options) {
  let source;
  try {
    source = projectAuthorityFile(workspace, 'checks.yaml', options);
    if (!fs.lstatSync(source.path, { throwIfNoEntry: false })) return { present: false, checks: null, error: null, source: source.path };
    const content = readFileNoFollow(source.path, { root: source.root, maxBytes: 1024 * 1024 });
    if (content === null) throw new Error('Named check source is unreadable or nonregular');
    const parsed = YAML.parse(content, { maxAliasCount: 50 });
    if (parsed?.version !== 1 || !parsed.checks || typeof parsed.checks !== 'object' || Array.isArray(parsed.checks)) {
      return { present: true, checks: null, error: `${source.display} must declare version: 1 and checks`, source: source.path };
    }
    return { present: true, checks: parsed.checks, error: null, source: source.path };
  } catch (error) {
    return { present: true, checks: null, error: `Invalid ${source?.display || 'project checks.yaml'}: ${error.message}`, source: source?.path };
  }
}

/** Bind the authoritative YAML parse to the gate session so hydrated hooks do
 * not need package resolution or a second, weaker YAML parser. */
export function configuredCheckSnapshot(workspace, options) {
  const loaded = loadConfiguredChecks(workspace, options);
  const source = loaded.error ? null : projectAuthorityFile(workspace, 'checks.yaml', options);
  if (loaded.error) return { digest: null, commands: [], error: loaded.error };
  const bytes = readFileNoFollow(source.path, { root: source.root, maxBytes: 1024 * 1024 });
  const commands = Object.entries(loaded.checks || {})
    .filter(([, config]) => Array.isArray(config?.command)
      && config.command.length > 0
      && config.command.every((part) => typeof part === 'string' && part.length > 0))
    .map(([name, config]) => ({ name, argv: config.command.slice() }));
  return {
    digest: bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex'),
    commands,
    error: null,
  };
}

function schemaFocused(name, config) {
  const descriptor = [name, ...(Array.isArray(config?.command) ? config.command : [])]
    .join(' ')
    .toLowerCase();
  return /(^|[^a-z])schema([^a-z]|$)/.test(descriptor);
}

function hasSchemaOutput(outputs) {
  return outputs.some((output) => {
    const normalized = String(output).toLowerCase();
    return /(^|[/_.-])schemas?([/_.-]|$)/.test(normalized) || /\.schema\.[a-z0-9]+$/.test(normalized);
  });
}

function relevantAlternatives(configured) {
  return Object.entries(configured)
    .filter(([name, config]) => !schemaFocused(name, config))
    .map(([name]) => name);
}

export function validatePlanReadiness(workspace, plan, { copilotHome } = {}) {
  const checks = [];
  if (!plan) return { pass: false, checks: [result('readiness-plan', false, 'Plan not found')] };
  checks.push(gapEvidenceCheck(workspace, plan));
  if (plan.fm.domain_binding || plan.fm.domain_parent || plan.fm.domain_child) {
    checks.push(sharedIntentCheck(workspace, plan, { home: planHome(workspace, plan) }));
    const link = domainLinkCheck({ workspace, plan, copilotHome, home: planHome(workspace, plan) });
    checks.push(result('domain-link', link.pass, link.message));
  }
  if (plan.fm.plan_id !== undefined) checks.push(result('plan-identity', typeof plan.fm.plan_id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(plan.fm.plan_id), 'CLI-owned plan identity requires a UUID'));
  if (plan.fm.playbook_binding !== undefined) {
    const procedure = validatePlaybookBinding(plan, { copilotHome });
    checks.push(result('playbook-binding', procedure.pass, procedure.message));
  }

  if (plan.status === 'planned') {
    const checkedCriteria = [...(plan.sections.acceptanceText || '').matchAll(/^-\s*\[[xX]\]\s+(.+)$/gm)].map((match) => match[1]);
    const checkedTasks = [...(plan.sections.plan || '').matchAll(/^-\s*\[[xX]\]\s+(.+)$/gm)].map((match) => match[1]);
    const clean = checkedCriteria.length === 0 && checkedTasks.length === 0;
    checks.push(
      result(
        'planned-work-state',
        clean,
        clean
          ? 'Planned acceptance criteria and tasks are unchecked'
          : `A planned plan cannot claim completed work (${checkedCriteria.length} checked criteria, ${checkedTasks.length} checked tasks); leave new items unchecked until implementation and evidence exist`
      )
    );
  }

  const required = Array.isArray(plan.fm.verification?.required) ? plan.fm.verification.required : [];
  const criteria = extractAcceptanceCriteria(plan);
  const mappings = plan.fm.verification?.criteria || {};
  checks.push(result('proof-obligation', criteria.length > 0 && new Set(criteria).size === criteria.length && required.length > 0,
    'Delivery requires nonempty unique criteria and required named checks'));
  const invalidMappings = criteria.filter((id) => {
    const mapped = mappings[id];
    return !Array.isArray(mapped) || mapped.length === 0 || mapped.some((name) => !required.includes(name));
  });
  checks.push(
    result(
      'criterion-mappings',
      invalidMappings.length === 0,
      invalidMappings.length
        ? `Every acceptance criterion must map to one or more verification.required checks; fix: ${invalidMappings.join(', ')}`
        : 'Every acceptance criterion maps to a required named check'
    )
  );

  const configured = loadConfiguredChecks(workspace, { home: planHome(workspace, plan) });
  if (configured.error) {
    checks.push(result('configured-checks', false, configured.error));
  } else if (configured.present) {
    const missing = required.filter((name) => {
      const command = configured.checks[name]?.command;
      return !Array.isArray(command) || !command.length || !command.every(part => typeof part === 'string' && part.trim());
    });
    checks.push(
      result(
        'configured-checks',
        missing.length === 0,
        missing.length ? `verification.required contains unconfigured checks: ${missing.join(', ')}` : 'All required checks are configured'
      )
    );

    const outputs = Array.isArray(plan.fm.expected_outputs) ? plan.fm.expected_outputs : [];
    const mismatched = required.filter(
      (name) => Object.hasOwn(configured.checks, name) && schemaFocused(name, configured.checks[name]) && !hasSchemaOutput(outputs)
    );
    const alternatives = relevantAlternatives(configured.checks);
    checks.push(
      result(
        'check-output-relevance',
        mismatched.length === 0,
        mismatched.length
          ? `Schema-focused check ${mismatched.join(', ')} is not relevant because expected_outputs contains no schema artifact; choose a relevant configured check${alternatives.length ? ` such as ${alternatives.join(', ')}` : ''}`
          : 'Required checks are relevant to the expected output types'
      )
    );
  } else checks.push(result('configured-checks', false, `No configured named checks; configure ${configured.source || 'the selected project checks.yaml'}`));

  return { pass: checks.every((check) => check.pass), checks };
}
