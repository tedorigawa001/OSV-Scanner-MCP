"""Local storage contract tests. HMAC test double only; VM uses real Ed25519."""
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('native_storage_contract', Path(__file__).with_name('storage.py'))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class TestKey:
    def sign(self, raw): return hmac.new(b'unit-test-double', raw, hashlib.sha256).digest()
    def public_key(self): return self
    def verify(self, signature, raw):
        if not hmac.compare_digest(signature, self.sign(raw)): raise ValueError('test-signature')


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.root = Path(self.temporary.name) / 'root'; self.root.mkdir(mode=0o700)
        self.context = {'runId': 'test-run', 'manifestDigest': 'a' * 64, 'providerBoot': 'b' * 64}; self.stores = []
    def tearDown(self):
        for store in self.stores: store.close()
        self.temporary.cleanup()
    def open(self, anchor=None, fault=lambda: 'none'):
        store = module.Store(self.root, TestKey(), self.context, {'sealDigest': anchor}, fault); self.stores.append(store); return store
    def sealed(self):
        store = self.open(); store.operate('upload', 'stage', {'payload': 'cGF5bG9hZA=='})
        result = store.operate('publish', 'seal', {}); return store, result
    def test_durable_roundtrip_and_recovery(self):
        store, result = self.sealed(); self.assertGreaterEqual(store.syncs['file'], 8); self.assertGreaterEqual(store.syncs['directory'], 5)
        self.assertEqual(store.operate('reader', 'read-state', {})['payload'], 'cGF5bG9hZA=='); store.close()
        recovered = self.open(result['sealDigest']); self.assertTrue(recovered.recovered); self.assertEqual(recovered.operate('reader', 'read-state', {})['sealDigest'], result['sealDigest'])
    def test_exclusive_writer(self):
        self.open()
        with self.assertRaises(BlockingIOError): self.open()
    def test_root_symlink(self):
        self.root.rename(self.root.with_name('actual')); self.root.symlink_to(self.root.with_name('actual'))
        with self.assertRaisesRegex(ValueError, 'root-custody'): self.open()
    def test_root_replacement(self):
        store = self.open(); self.root.rename(self.root.with_name('old')); self.root.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, 'root-exchanged'): store.operate('reader', 'read-state', {})
    def test_unapproved_recovery(self):
        store, _ = self.sealed(); store.close()
        with self.assertRaisesRegex(ValueError, 'recovery-anchor'): self.open()
    def test_anchor_cannot_revive_empty_store(self):
        with self.assertRaisesRegex(ValueError, 'rollback'): self.open('1' * 64)
    def test_unknown_entry(self):
        store, result = self.sealed(); store.close(); (self.root / 'unknown').write_bytes(b'x')
        with self.assertRaisesRegex(ValueError, 'inventory-budget|unknown-entry'): self.open(result['sealDigest'])
    def test_same_size_tamper(self):
        store, result = self.sealed(); store.close(); (self.root / 'data.bin').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'content'): self.open(result['sealDigest'])
    def test_symlink_file(self):
        store, result = self.sealed(); store.close(); target = self.root / 'data.bin'; target.unlink(); target.symlink_to('/dev/null')
        with self.assertRaises(OSError): self.open(result['sealDigest'])
    def test_hardlink_file(self):
        store, result = self.sealed(); store.close(); os.link(self.root / 'data.bin', self.root.parent / 'alias')
        with self.assertRaisesRegex(ValueError, 'file-custody'): self.open(result['sealDigest'])
    def test_missing_selection(self):
        store, result = self.sealed(); store.close(); (self.root / 'selected.json').unlink()
        with self.assertRaisesRegex(ValueError, 'incomplete-inventory'): self.open(result['sealDigest'])
    def test_invalid_role_does_not_poison_owner(self):
        store = self.open()
        with self.assertRaisesRegex(ValueError, 'role'): store.operate('reader', 'stage', {'payload': 'eA=='})
        self.assertEqual(store.operate('reader', 'read-state', {})['phase'], 'empty')
    def test_no_path_argument(self):
        store = self.open()
        with self.assertRaisesRegex(ValueError, 'argument'): store.operate('upload', 'stage', {'payload': 'eA==', 'path': '/tmp/escape'})
        self.assertEqual(store.names(), {'lock'})
    def test_payload_limit(self):
        store = self.open()
        import base64
        with self.assertRaisesRegex(ValueError, 'payload'): store.operate('upload', 'stage', {'payload': base64.b64encode(b'x' * 513).decode()})
        self.assertEqual(store.names(), {'lock'})


def failure_test(fault):
    def test(self):
        selected = ['none']; store = self.open(fault=lambda: selected[0])
        operation = 'stage' if fault in ('write', 'file-limit', 'file-sync', 'directory-sync', 'after-data') else 'seal'
        if operation == 'seal': store.operate('upload', 'stage', {'payload': 'eA=='})
        selected[0] = fault
        with self.assertRaises(OSError): store.operate('upload' if operation == 'stage' else 'publish', operation, {'payload': 'eA=='} if operation == 'stage' else {})
        selected[0] = 'none'
        with self.assertRaisesRegex(ValueError, 'unavailable'): store.operate('reader', 'read-state', {})
        store.close()
        with self.assertRaises(ValueError): self.open()
    return test


for phase in ('write', 'file-limit', 'file-sync', 'directory-sync', 'after-data', 'after-seal', 'after-selection', 'before-response'):
    setattr(StorageTests, 'test_failure_' + phase.replace('-', '_'), failure_test(phase))


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(StorageTests); result = unittest.TextTestRunner(verbosity=0).run(suite)
    print(json.dumps({'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors), 'nativeIsolationVerified': False}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
