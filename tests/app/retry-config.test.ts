import assert from 'node:assert/strict';
import test from 'node:test';
import { providerRetryConfigFromEffective } from '../../packages/app/src/retry-config.js';

test('compiles effective user execution providerRetry into a runtime RetryCycleConfigSet', () => {
  const config = providerRetryConfigFromEffective({
    effective: {
      provider: {
        provider: 'rcc',
        binding: 'rcc-entry',
        protocol: 'responses',
        model: 'MiniMax-M3',
        route: 'default',
        baseUrl: 'http://127.0.0.1:4444',
      },
      execution: {
        providerRetry: {
          candidates: [
            { provider: 'rcc', binding: 'provider-a', protocol: 'responses', model: 'model-a', route: 'route-a', baseUrl: 'http://127.0.0.1:4444' },
            { provider: 'rcc', binding: 'provider-b', protocol: 'responses', model: 'model-b', route: 'route-b', baseUrl: 'http://127.0.0.1:4444' },
          ],
        },
      },
    },
  });
  assert.ok(config);
  if (!config) return;
  assert.equal(config.configRevision, 'execution.providerRetry');
  assert.equal(config.candidates.length, 2);
  assert.equal(config.candidates[0]!.binding.bindingId, 'provider-a:0');
  assert.equal(config.candidates[0]!.binding.providerId, 'rcc');
  assert.equal(config.candidates[1]!.binding.bindingId, 'provider-b:1');
  assert.equal(config.candidates[0]!.admission.capabilityDigest, 'sha256:rcc:capability:default');
});

test('returns undefined when provider retry is not configured', () => {
  assert.equal(providerRetryConfigFromEffective({ effective: { provider: { provider: 'rcc', binding: 'rcc', protocol: 'responses', model: 'x', route: 'default', baseUrl: 'http://127.0.0.1:4444' } } }), undefined);
});
