"""Build the patched DOS engine with Docker; keep all work in a named output dir.

Usage: python scripts/build-fastdoom.py [_localmod/doom/fastdoom-rebuild]
The output directory must not already contain a FastDoom source directory.
"""
from pathlib import Path
import hashlib
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import io
import gzip
import runpy
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'games/dos'
OW_URL = 'https://github.com/open-watcom/open-watcom-v2/releases/download/2026-06-01-Build/ow-snapshot.tar.xz'
OW_SHA = '551c4c8bd7365858da2b9969e30c42d06421a637f25f85c1f2f58beb14e7588d'
IMAGE = 'node@sha256:be40f6a87b9b22215ddb20da0a2320a5c6d583fe3ee3b0024d9fa4f05b40c8fd'
NOTICE = '''FastDoom 1.3.0-aobing1, modified by Aobing on 2026-09-21.
GPL-2.0-or-later; see the included COPYING and original copyright notices.

Changes: normalize/interpolate plane height before lookup, keep sky height zero,
increase the plane capacity to 1024, and check both allocation paths before
writing. Add an explicit dword size to the optional CPUID assembly for NASM.
The save-game format and game rules are unchanged.

Corresponding source: ../sources/fastdoom-1.3.0-aobing1.tar.gz includes the full
patched upstream source and AOBING_BUILD scripts. From the Aobing repository,
run python scripts/build-fastdoom.py to build and package using Docker, then
python scripts/vendor-dos.py to update the game bundle and checksums.
To build from the source archive alone, put its FastDoom-1.3.0 directory in an
empty work directory, download the Watcom snapshot below as watcom.tar.xz,
verify its hash, and run AOBING_BUILD/build-fastdoom.sh in the pinned container
with that work directory bind-mounted at /work.

Open Watcom: ''' + OW_URL + '\nSHA-256: ' + OW_SHA + '\nDocker image: ' + IMAGE + '''
NASM 2.16.03-1; DOSBox 0.74-3-5+b1 (Debian trixie).
Build: MODE_13H, upstream GNU make flags, four compiler jobs, DOS/32A 9.1.2
extender configured with upstream DOS32A.D32. Compiler objects are not shipped.
'''

def install_package(work):
    source = work / 'FastDoom-1.3.0'
    exe = (source / 'FDOOM13H.EXE').read_bytes()
    if len(exe) < 800000 or int.from_bytes(exe[60:64], 'little') < 20000:
        raise ValueError('Missing embedded DOS32/A extender')
    output = ASSETS / 'patches/fastdoom-1.3.0-aobing1.zip'
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output.with_suffix('.tmp'), 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in [('FDOOM13H.EXE', exe), ('NOTICE.txt', NOTICE.encode()),
                           ('COPYING', (source / 'FASTDOOM/LICENSE').read_bytes())]:
            info = zipfile.ZipInfo(name, (2026, 9, 21, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    output.with_suffix('.tmp').replace(output)
    # Use the pristine source manifest, replacing only the two patched files.
    # Never package compiler outputs or the downloaded toolchain.
    data = io.BytesIO()
    with tarfile.open(ASSETS / 'sources/fastdoom-1.3.0.tar.gz') as original, tarfile.open(fileobj=data, mode='w') as archive:
        for entry in original:
            contents = original.extractfile(entry).read() if entry.isfile() else None
            if entry.name.endswith(('/FASTDOOM/r_plane.c', '/FASTDOOM/fpummx.asm')):
                contents = (source / entry.name.split('/', 1)[1]).read_bytes()
                entry.size = len(contents)
            archive.addfile(entry, io.BytesIO(contents) if contents is not None else None)
        extra = {'NOTICE.txt': NOTICE.encode()}
        for script in ['build-fastdoom.py', 'build-fastdoom.sh', 'patch-fastdoom.py', 'test-fastdoom-planes.py']:
            extra['AOBING_BUILD/' + script] = (ROOT / 'scripts' / script).read_bytes()
        for name, contents in extra.items():
            info = tarfile.TarInfo('FastDoom-1.3.0/' + name); info.size = len(contents)
            info.mode = 0o644; info.mtime = 1790035200
            archive.addfile(info, io.BytesIO(contents))
    output = ASSETS / 'sources/fastdoom-1.3.0-aobing1.tar.gz'
    output.with_suffix('.tmp').write_bytes(gzip.compress(data.getvalue(), mtime=0))
    output.with_suffix('.tmp').replace(output)
    print('Packaged engine SHA-256:', hashlib.sha256(exe).hexdigest())

if __name__ == '__main__':
    args = sys.argv[1:]
    package_only = bool(args and args[0] == '--package-only')
    if package_only: args.pop(0)
    work = (Path(args[0]) if args else ROOT / '_localmod/doom/fastdoom-rebuild').resolve()
    if not package_only:
        if (work / 'FastDoom-1.3.0').exists():
            raise SystemExit('Use a fresh output directory for a clean build.')
        work.mkdir(parents=True, exist_ok=True)
        archive_path = work / 'watcom.tar.xz'
        if not archive_path.exists(): urllib.request.urlretrieve(OW_URL, archive_path)
        if hashlib.sha256(archive_path.read_bytes()).hexdigest() != OW_SHA:
            raise ValueError('Watcom checksum mismatch')
        with tarfile.open(ASSETS / 'sources/fastdoom-1.3.0.tar.gz') as archive:
            archive.extractall(work, filter='data')
        runpy.run_path(str(ROOT / 'scripts/patch-fastdoom.py'))['patch'](work / 'FastDoom-1.3.0')
        shutil.copyfile(ROOT / 'scripts/build-fastdoom.sh', work / 'compile.sh')
        subprocess.run(['docker', 'run', '--rm', '--mount', 'type=bind,source=' + str(work) + ',target=/work',
                        IMAGE, 'bash', '/work/compile.sh'], check=True)
    install_package(work)
