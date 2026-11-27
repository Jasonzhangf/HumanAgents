import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createResponsesFileToolExecutor,
  RESPONSES_WORKSPACE_INVENTORY_TOOL,
} from '../../packages/app/src/provider-tool-execution.js'

const request = {
  signal: new AbortController().signal,
  call: { toolId: RESPONSES_WORKSPACE_INVENTORY_TOOL.toolId, arguments: {}, callId: 'inventory-call' },
} as never

test('workspace inventory has no model-supplied path or command arguments', () => {
  assert.deepEqual(RESPONSES_WORKSPACE_INVENTORY_TOOL.inputSchema.properties, {})
  assert.equal(RESPONSES_WORKSPACE_INVENTORY_TOOL.inputSchema.required, undefined)
  assert.equal(RESPONSES_WORKSPACE_INVENTORY_TOOL.inputSchema.additionalProperties, false)
})

test('workspace inventory stays unregistered without a trusted host root', async () => {
  const disabled = createResponsesFileToolExecutor({
    workspaceRoot: '/tmp/alex-task-workspace',
    projectKey: 'alex-native-tools',
    artifactRoot: '/tmp/alex-evidence',
  })
  await assert.rejects(() => disabled.executor.execute(request), /provider tool is not registered/)
})

test('workspace inventory with a trusted host root reaches admission control', async () => {
  const enabled = createResponsesFileToolExecutor({
    workspaceRoot: '/tmp/alex-task-workspace',
    projectKey: 'alex-native-tools',
    artifactRoot: '/tmp/alex-evidence',
    readonlyInventoryRoot: '/tmp/authorized-inventory',
  })
  await assert.rejects(() => enabled.executor.execute(request), /provider tool control source is missing/)

})
