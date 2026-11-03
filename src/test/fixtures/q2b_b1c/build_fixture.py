"""Offline VM-only diagnostic variant. Does not deploy or authorize B1 adoption."""
import argparse
import hashlib
import json
import runpy
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = HERE.parent / 'q2b'


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError('parent source changed: ' + old)
    return text.replace(old, new)


def build(destination, runtime=None, compile_binary=False):
    # Keep the reviewed B1b startup profile and its saved evidence unchanged.
    # Transform checked source anchors, never silently accept parent drift.
    with tempfile.TemporaryDirectory(prefix='q2b-b1c-source-') as temporary:
        source = Path(temporary)
        for name in ('build_fixture.py', 'launcher.c', 'provider.py'):
            text = (BASE / name).read_text().replace('b1b', 'b1c').replace('B1b', 'B1c')
            if name == 'build_fixture.py':
                # There are two separately constrained contexts: service and prepare.
                if text.count('UnsetEnvironment={DANGEROUS}') != 2:
                    raise ValueError('parent environment anchors changed')
                text = text.replace('UnsetEnvironment={DANGEROUS}',
                                    'UnsetEnvironment=MEMORY_PRESSURE_WATCH MEMORY_PRESSURE_WRITE {DANGEROUS}')
                text = replace_once(text, 'AmbientCapabilities=\n',
                                    'AmbientCapabilities=CAP_SETUID CAP_SETGID CAP_SETPCAP\n')
            elif name == 'launcher.c':
                text = replace_once(text, 'st.st_size<=4*1024*1024', 'st.st_size<=8*1024*1024')
            elif name == 'provider.py':
                # Retain listeners for independent /proc observation. No accept/key/read path.
                text = replace_once(text, '    return {\'schema\':',
                                    '    globals()["retained_listeners"] = listeners\n    return {\'schema\':')
                text = replace_once(text, 'print(json.dumps(inspect(), sort_keys=True))',
                                    'print(json.dumps(inspect(), sort_keys=True), flush=True)\n'
                                    '        import signal\n        signal.pause()')
            (source / name).write_text(text)
        module = runpy.run_path(str(source / 'build_fixture.py'))
        previous = sys.executable
        try:
            if runtime:
                candidate = Path(runtime)
                if candidate.is_symlink() or not candidate.is_file() or not 0 < candidate.stat().st_size <= 8 * 1024 * 1024:
                    raise ValueError('runtime must be a pinned regular file within the VM profile budget')
                sys.executable = str(candidate.resolve())
            module['build'](Path(destination), compile_binary)
        finally:
            sys.executable = previous
    out = Path(destination)
    unit = out / 'rootfs/etc/systemd/system/osv-q2b-b1c.service'
    unit.write_text(replace_once(unit.read_text(), 'Type=oneshot\nRemainAfterExit=yes', 'Type=simple'))
    inventory = json.loads((out / 'bundle.json').read_text())
    for item in sorted((out / 'rootfs/etc/systemd/system').iterdir()):
        text = item.read_text()
        name = item.name
        for role in ('reader', 'upload', 'publish'):
            text = text.replace('osv-q2b-' + role + '.socket', 'osv-q2b-b1c-' + role + '.socket')
            name = name.replace('osv-q2b-' + role + '.socket', 'osv-q2b-b1c-' + role + '.socket')
        if name != item.name:
            item.unlink()
        item.with_name(name).write_text(text)
    inventory['scope'] = 'b1c-vm-diagnostic-only'
    inventory['parentSources'] = [{ 'path': name, 'sha256': hashlib.sha256((BASE / name).read_bytes()).hexdigest() }
                                  for name in ('build_fixture.py', 'launcher.c', 'provider.py')]
    inventory['files'] = [{'path': '/' + str(p.relative_to(out / 'rootfs')), 'size': p.stat().st_size,
                           'mode': p.stat().st_mode & 0o777, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                          for p in sorted((out / 'rootfs').rglob('*')) if p.is_file()]
    (out / 'bundle.json').write_text(json.dumps(inventory, sort_keys=True, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination')
    parser.add_argument('--runtime')
    parser.add_argument('--compile', action='store_true')
    args = parser.parse_args()
    build(args.destination, args.runtime, args.compile)
