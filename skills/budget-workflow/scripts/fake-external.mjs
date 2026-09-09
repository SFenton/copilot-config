export const FAKE_DRIVER_CLASSES = new Set([
  'github-pr',
  'github-release',
  'github-workflow',
  'home-assistant',
  'hacs-verification',
  'production-deploy',
  'database-capture',
  'rollback',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function runFakeExternalDriver(tool, state, scenario = 'success') {
  assert(tool?.kind === 'fake-driver' && FAKE_DRIVER_CLASSES.has(tool.driverClass),
    'Registered fake external driver required');
  assert(['execute', 'verify', 'rollback', 'cleanup'].includes(tool.action),
    'Fake driver action unsupported');
  assert(state && typeof state === 'object' && !Array.isArray(state),
    'Mutable in-memory fake state required');
  assert(['success', 'reject', 'abnormal'].includes(scenario),
    'Fake driver scenario unsupported');
  state.events ??= [];
  state.resources ??= {};
  const event = {
    driverClass: tool.driverClass,
    action: tool.action,
    scenario,
    sequence: state.events.length,
  };
  state.events.push(event);
  if (scenario === 'reject') {
    return {
      status: 'rejected',
      exitCode: 2,
      stdout: '',
      stderr: `${tool.driverClass}/${tool.action}: expected rejection`,
      error: null,
    };
  }
  if (scenario === 'abnormal') {
    return {
      status: 'abnormal',
      exitCode: 70,
      stdout: '',
      stderr: `${tool.driverClass}/${tool.action}: abnormal fake failure`,
      error: 'abnormal fake failure',
    };
  }
  if (tool.action === 'execute') state.resources[tool.driverClass] = 'active';
  if (tool.action === 'verify') {
    const current = state.resources[tool.driverClass];
    assert(current === 'active' || current === 'rolled-back',
      `${tool.driverClass}: nothing exists to verify`);
  }
  if (tool.action === 'rollback') state.resources[tool.driverClass] = 'rolled-back';
  if (tool.action === 'cleanup') state.cleaned = true;
  return {
    status: 'accepted',
    exitCode: 0,
    stdout: JSON.stringify(event),
    stderr: '',
    error: null,
  };
}
