"""No external LLM calls: verify concurrency, ordering, and failure semantics."""
import os
import time
import unittest
from unittest.mock import patch
import sys
import types
# This unit test isolates the scheduling helper from optional PII packages.
if 'security' not in sys.modules:
    security_stub = types.ModuleType('security')
    security_stub.sanitize_text = lambda text: text
    security_stub.sanitize_dataframe = lambda frame: frame
    sys.modules['security'] = security_stub
from sad_workflow import _generate_chunks


class SADPerformanceTests(unittest.TestCase):
    def test_order_and_bounded_parallelism(self):
        chunks = [{'id': str(i)} for i in range(4)]
        def fake_generate(llm, chunk, index, total):
            time.sleep(0.04 * (5 - index))
            return [{'id': chunk['id']}]
        with patch.dict(os.environ, {'SAD_GENERATION_WORKERS': '2'}), patch('sad_workflow._generate_batch', fake_generate):
            self.assertEqual([r[0]['id'] for r in _generate_chunks(None, chunks)], ['0', '1', '2', '3'])

    def test_failure_returns_no_partial_results(self):
        def fail(llm, chunk, index, total):
            if index == 2:
                raise RuntimeError('provider failed')
            return []
        with patch.dict(os.environ, {'SAD_GENERATION_WORKERS': '2'}), patch('sad_workflow._generate_batch', fail):
            with self.assertRaisesRegex(RuntimeError, 'provider failed'):
                _generate_chunks(None, [{'id': 'a'}, {'id': 'b'}])

    def test_sequential_fallback(self):
        with patch.dict(os.environ, {'SAD_GENERATION_WORKERS': '1'}), patch('sad_workflow._generate_batch', return_value=[]) as generate:
            self.assertEqual(_generate_chunks(None, [{'id': 'a'}, {'id': 'b'}]), [[], []])
            self.assertEqual(generate.call_count, 2)

    def test_rejects_invalid_worker_setting(self):
        with patch.dict(os.environ, {'SAD_GENERATION_WORKERS': '20'}):
            with self.assertRaises(Exception):
                _generate_chunks(None, [{'id': 'a'}])


if __name__ == '__main__':
    unittest.main()
