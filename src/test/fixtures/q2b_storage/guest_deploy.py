"""Fresh VM only. Reuse fixed installer with a real disk-backed bind mount."""
import runpy
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main(bundle_pin, credential_pin):
    source = (HERE / 'storage-base-deploy.py').read_text()
    def once(old, new):
        nonlocal source
        if source.count(old) != 1: raise ValueError('storage deploy anchor changed: ' + old)
        source = source.replace(old, new)
    once("'native-transport-diagnostic-only'", "'native-storage-diagnostic-only'")
    once("32 * 1024 * 1024, 32)", "32 * 1024 * 1024, 64)")
    once("'crypto-image.json')", "'crypto-image.json', 'storage.py', 'storage_client.py')")
    once("subprocess.run(['mount', '-t', 'tmpfs', '-o', 'nosuid,nodev,noexec,mode=0755,size=64M', 'tmpfs', str(STATE)], check=True, timeout=30)",
         "subprocess.run(['mount', '--bind', str(STATE), str(STATE)], check=True, timeout=30)\n    subprocess.run(['mount', '-o', 'remount,bind,rw,nosuid,nodev,noexec', str(STATE)], check=True, timeout=30)")
    once("'filesystem': 'tmpfs'", "'filesystem': 'ext4'")
    once("mount[0] == 'tmpfs'", "mount[0] == 'ext4'")
    once("    (RUN / 'fault').write_text('none')", "    storage = STATE / 'provider/b1ct/storage'; storage.mkdir(mode=0o700); os.chown(storage, 1101, 1201)\n    (RUN / 'storage-fault').write_text('none'); (RUN / 'storage-fault').chmod(0o644)\n    (RUN / 'recovery-anchor.json').write_bytes(canonical({'sealDigest': None})); (RUN / 'recovery-anchor.json').chmod(0o644)\n    (RUN / 'fault').write_text('none')")
    namespace = {'__name__': 'storage_deploy_composition'}; exec(compile(source, 'fixed-storage-deploy', 'exec'), namespace)
    namespace['main'](bundle_pin, credential_pin)


if __name__ == '__main__': main(sys.argv[1], sys.argv[2])
