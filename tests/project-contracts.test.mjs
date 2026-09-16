import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { audit, readAdapter } from '../skills/budget-workflow/scripts/budget.mjs';
import { readOpportunityPolicy } from '../skills/budget-workflow/scripts/opportunities.mjs';
import { readReleaseMachine } from '../skills/budget-workflow/scripts/release-machine.mjs';
import {
  expectedOpportunityIds,
  instructionContractCheck,
  loadProjectManifest,
  releaseSkillCheck,
} from '../scripts/project-manifest.mjs';
import {
  sha256,
  validateToolRegistry,
} from '../skills/budget-workflow/scripts/workflow.mjs';

const manifest = process.env.BUDGET_PROJECT_MANIFEST;
const studyBudget = JSON.parse(fs.readFileSync(
  new URL('../evals/capability-study-budget.json', import.meta.url),
  'utf8',
));
const studyCapabilityById = new Map(studyBudget.capabilities.map(item =>
  [item.id, item]));
test('project adapters resolve and relocated contracts retain original detailed requirements',
  { skip: !manifest }, async () => {
      const data = loadProjectManifest(manifest);
    for (const item of data.cases) {
      const adapter = readAdapter(item.root);
      assert.ok(adapter.gates.length > 0);
      for (const key of [
        'learningPolicy',
        'opportunityPolicy',
        'toolRegistry',
        'opportunityEvaluation',
        'workerEvaluation',
        'capabilityEvaluation',
        'sandboxProfiles',
        'releaseMachine',
      ]) {
        assert.equal(typeof adapter[key], 'string',
          `${item.id}: adapter ${key} is required`);
      }
      assert.deepEqual(adapter.delegation, {
        allowedClasses: ['test-generation'],
        requireCleanTargets: true,
        requireDeterministicValidator: true,
      }, `${item.id}: delegation policy must remain the qualified staging contract`);
      if (adapter.toolRegistry) {
        const registry = validateToolRegistry(JSON.parse(
          fs.readFileSync(path.join(item.root, adapter.toolRegistry), 'utf8'),
        ), adapter.project);
        assert.ok(registry.tools.length > 0);
      }
      if (adapter.capabilityEvaluation) {
        const qualification = JSON.parse(
          fs.readFileSync(path.join(item.root, adapter.capabilityEvaluation), 'utf8'),
        );
        assert.equal(qualification.project, adapter.project);
        assert.ok(qualification.capabilities.every(capability =>
          capability.status === 'provisional' &&
          capability.trustTier === 'provisional-staging' &&
          capability.reviewedApplication === false &&
          capability.unattendedApplication === false &&
          capability.currentCases < capability.minimumCases &&
          capability.automaticApplication === false &&
          capability.allLegBenchmark === 'planned-no-run' &&
          capability.studyBudget?.selected === false &&
          capability.sandbox?.status === 'qualified' &&
          capability.sandbox?.network === 'none'));
        const workerEvaluation = JSON.parse(fs.readFileSync(
          path.join(item.root, adapter.workerEvaluation),
          'utf8',
        ));
        const sandboxProfiles = JSON.parse(fs.readFileSync(
          path.join(item.root, adapter.sandboxProfiles),
          'utf8',
        ));
        for (const capability of qualification.capabilities) {
          const planned = studyCapabilityById.get(capability.id);
          assert.ok(planned, `${capability.id}: shared study budget entry missing`);
          assert.equal(planned.currentCases, capability.currentCases,
            `${capability.id}: shared/project case-count drift`);
          assert.equal(capability.remainingCases,
            capability.minimumCases - capability.currentCases);
          assert.equal(capability.studyBudget.missingCases,
            capability.remainingCases);
          assert.equal(capability.studyBudget.modelCalls, 0);
          assert.equal(capability.studyBudget.maximumCredits, 0);
          assert.equal(capability.studyBudget.maximumTokens, 0);
          assert.equal(capability.studyBudget.runStudy, false);
          const profile = sandboxProfiles.profiles.find(value =>
            value.id === capability.id);
          assert.ok(profile, `${capability.id}: sandbox profile missing`);
          assert.equal(capability.sandbox.profileHash, sha256(profile));
          assert.equal(capability.sandbox.imageId,
            profile.sandbox.expectedImageId);
          assert.equal(capability.sandbox.dependencyPolicyHash,
            sha256(profile.sandbox.dependencyMounts ?? []));
          if (workerEvaluation.qualificationStatus?.startsWith('invalidated')) {
            assert.equal(capability.currentCases, 0,
              `${capability.id}: invalidated worker evidence cannot count`);
          }
        }
      }
      if (adapter.sandboxProfiles) {
        const profiles = JSON.parse(
          fs.readFileSync(path.join(item.root, adapter.sandboxProfiles), 'utf8'),
        );
        assert.equal(profiles.project, adapter.project);
        assert.ok(profiles.profiles.length > 0);
      }
      if (adapter.opportunityPolicy) {
        const policy = readOpportunityPolicy(item.root, adapter);
        assert.ok(policy.opportunities.length > 0);
        const expectedIds = expectedOpportunityIds(item);
        if (expectedIds.length > 0) {
          assert.deepEqual(policy.opportunities.map(entry => entry.id).sort(),
            [...expectedIds].sort());
        }
        const profileIds = new Set(JSON.parse(fs.readFileSync(
          path.join(item.root, adapter.sandboxProfiles),
          'utf8',
        )).profiles.map(profile => profile.id));
        for (const opportunity of policy.opportunities) {
          for (const phase of opportunity.phases.filter(value =>
            value.kind === 'cheap-worker')) {
            const worker = opportunity.team.workerCandidate;
            assert.ok(profileIds.has(worker.sandboxProfile),
              `${item.id}/${opportunity.id}/${phase.id}: sandbox profile missing`);
          }
          if (adapter.releaseMachine) {
            const machine = readReleaseMachine(item.root, adapter);
            const releaseOpportunity = policy.opportunities.find(opportunity =>
              opportunity.id === machine.opportunity);
            assert.deepEqual(machine.reviewer.profile,
              releaseOpportunity.team.reviewer.profile,
            `${item.id}: release machine reviewer must match the pipeline reviewer`);
            assert.ok(machine.exception.triggerIds.every(trigger =>
              releaseOpportunity.conditionalProfiles.some(profile =>
                ['research-frontier', 'risk-triggered-frontier-review'].includes(profile.kind) &&
                profile.triggerIds.includes(trigger))),
            `${item.id}: machine exception triggers must exist in opportunity policy`);
          }
        }
      }
      const releaseSkill = releaseSkillCheck(item);
      if (releaseSkill) {
        const releaseSkillText = fs.readFileSync(path.join(
          item.root,
          releaseSkill.path,
        ), 'utf8');
        assert.doesNotMatch(releaseSkillText, /That invocation authorizes/);
        assert.doesNotMatch(releaseSkillText, /## Git and GitHub release/);
        assert.doesNotMatch(releaseSkillText, /\bstage an exact patch\b/i);
        assert.doesNotMatch(releaseSkillText, /\bgit add\b/i);
        assert.match(releaseSkillText, /blocked: release-machine-disabled/);
        assert.match(releaseSkillText, /medium model\s+cannot substitute/i);
      }
      const hook = JSON.parse(fs.readFileSync(path.join(item.root, '.github/hooks/budget-reads.json'), 'utf8'));
      assert.equal(hook.version, 1);
      assert.equal(Array.isArray(hook.hooks.preToolUse), false);
      assert.equal(hook.hooks.userPromptSubmitted.length, 1);
      assert.equal(hook.hooks.sessionEnd.length, 1);
      assert.deepEqual(Object.keys(hook.hooks).sort(), ['sessionEnd', 'userPromptSubmitted']);
      const after = audit(item.root);
      assert.deepEqual(after.findings.filter(finding => finding.type === 'missing-link'), []);
      if (adapter.destructiveMaintenanceMachine) {
        const release = readReleaseMachine(item.root, adapter);
        const destructive = readReleaseMachine(item.root, {
          ...adapter,
          releaseMachine: adapter.destructiveMaintenanceMachine,
        });
        assert.notDeepEqual(
          release.steps.map(step => step.id),
          destructive.steps.map(step => step.id),
        );
        assert.equal(release.variant, 'application-release');
        assert.equal(destructive.variant, 'destructive-maintenance');
        const policy = readOpportunityPolicy(item.root, adapter);
        const pipeline = policy.opportunities.find(opportunity =>
          opportunity.id === destructive.opportunity);
        assert.deepEqual(destructive.reviewer.profile,
          pipeline.team.reviewer.profile);
        assert.match(destructive.steps.find(step => step.operation === 'rollback').label,
          /logical archive/i);
      }
      const instruction = instructionContractCheck(item);
      if (instruction) {
        const baseline = instruction.baselineRef ?? 'HEAD';
        const migration = instruction.migrationRef;
        const previous = execFileSync('git', ['-C', item.root, 'show', `${baseline}:.github/copilot-instructions.md`], { encoding: 'utf8' });
        const migrated = migration
          ? execFileSync('git', ['-C', item.root, 'show', `${migration}:${instruction.path}`], { encoding: 'utf8' })
          : fs.readFileSync(path.join(item.root, instruction.path), 'utf8');
        assert.ok(migrated.endsWith(previous.slice(previous.indexOf('\n') + 1)),
          `${item.id} contract migration must preserve the prior contract verbatim after its heading`);
        assert.equal(fs.statSync(path.join(item.root, instruction.path)).isFile(), true);
        assert.equal(after.files.find(file => file.file === instruction.path).loading, 'task-reference');
      }
    }
  });
