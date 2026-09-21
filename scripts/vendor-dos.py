"""Rebuild the pinned DOS assets with Python's standard library (no npm needed).

Run from any directory: python scripts/vendor-dos.py
Archives are read in memory; no upstream paths are extracted onto the filesystem.
"""
from pathlib import Path
import base64
import hashlib
import io
import json
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1] / 'games' / 'dos'
EMU_REV = '5f4eea600b0623b4621800d64372d837e8680579'
DOSBOX_REV = '528578d5a6f76afd4d5ef4e722b5670826f1183a'


def download(url, digest=None, algorithm='sha256'):
    data = urllib.request.urlopen(url, timeout=90).read()
    if digest and hashlib.new(algorithm, data).hexdigest() != digest:
        raise ValueError('Upstream archive checksum mismatch: ' + url)
    return data


def write(path, data):
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    # A running local preview must never serve half-written JS/WASM/ZIP data.
    temporary = target.with_name(target.name + '.tmp')
    temporary.write_bytes(data)
    temporary.replace(target)


def bundle(path, files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 9, 20, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    write(path, buffer.getvalue())


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    integrity = 'oH6c89mcBF3TUABu31cVT0YSMHmTMMTQWgANNQ/+jNcJ0jHV68Ql5x1gZ+Csb7BUS+iCkY1pCVYbp09QDa+fMA=='
    npm = download('https://registry.npmjs.org/emulators/-/emulators-8.4.2.tgz',
                   base64.b64decode(integrity).hex(), 'sha512')
    with tarfile.open(fileobj=io.BytesIO(npm)) as archive:
        for name in ['emulators.js', 'wdosbox.js', 'wdosbox.wasm']:
            write('engine/' + name, archive.extractfile('package/dist/' + name).read())
        write('licenses/emulators-GPL-2.0.txt', archive.extractfile('package/LICENSE').read())

    fastdoom = download('https://github.com/viti95/FastDoom/releases/download/1.3.0/FastDoom_1.3.0.zip',
                        '4b805f3f712362d53797b3109ebf4651adb3bf28b903c91c4c477eba56121d6f')
    with zipfile.ZipFile(io.BytesIO(fastdoom)) as archive:
        files = {name: archive.read(name) for name in archive.namelist()
                 if not name.endswith('/') and (name in ['FDOOM.EXE', 'FDOOM13H.EXE', 'README.txt']
                 or name.startswith(('DATA/', 'TEXT/', 'LEVELS/')))}
    # Built from the corresponding patched GPL source with build-fastdoom.py.
    # Preserve FDOOM.EXE for already-open legacy launchers.
    with zipfile.ZipFile(ROOT / 'patches/fastdoom-1.3.0-aobing1.zip') as archive:
        patched = archive.read('FDOOM13H.EXE')
        if hashlib.sha256(patched).hexdigest() != '7f6d8b981116d179e0a928fa26074221c27f66fd8ce4f5995b834798d4502871':
            raise ValueError('Patched engine checksum mismatch; verify the rebuild before updating this pin')
        files['FDOOM13H.EXE'] = patched
        files['AOBING.TXT'] = archive.read('NOTICE.txt')
    files['DEFAULT.CFG'] = b'''snd_musicdevice 3
snd_sfxdevice 3
sfx_volume 10
music_volume 7
show_messages 1
screenblocks 10
use_mouse 1
mouse_sensitivity 5
key_up 17
key_down 31
key_strafeleft 30
key_straferight 32
key_fire 57
key_use 18
'''
    bundle('doom-engine.zip', files)

    freedos = download('https://ibiblio.org/pub/micro/pc-stuff/freedos/files/repositories/latest/games/freedoom.zip',
                      '3496e15376bdf687e58ca03bc7f3832a819258a29e0672b6cd090e7852f75bc3')
    with zipfile.ZipFile(io.BytesIO(freedos)) as archive:
        bundle('freedoom.zip', {'FREEDM1.WAD': archive.read('GAMES/FREEDOOM/PHASE1/DOOM.WAD')})
        write('licenses/freedoom-BSD.txt', archive.read('GAMES/FREEDOOM/DOCS/COPYING.txt'))
        write('licenses/freedoom-credits.txt', archive.read('GAMES/FREEDOOM/DOCS/CREDITS.txt'))

    for repo, ref, filename in [
        ('js-dos/emulators', EMU_REV, 'emulators-8.4.2.tar.gz'),
        ('js-dos/dosbox', DOSBOX_REV, 'dosbox-source.tar.gz'),
        ('viti95/FastDoom', 'refs/tags/1.3.0', 'fastdoom-1.3.0.tar.gz'),
    ]:
        data = download('https://codeload.github.com/' + repo + '/tar.gz/' + ref)
        write('sources/' + filename, data)
        if repo == 'viti95/FastDoom':
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                write('licenses/fastdoom-GPL-2.0.txt', archive.extractfile('FastDoom-1.3.0/FASTDOOM/LICENSE').read())
    paths = sorted(p for p in ROOT.rglob('*') if p.is_file() and
                   (p.parent.name in ['engine', 'sources', 'licenses', 'patches'] or p.suffix == '.zip'))
    checksums = {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    write('checksums.json', (json.dumps(checksums, indent=2) + '\n').encode())
    print('Rebuilt', len(paths), 'pinned DOS assets in', ROOT)


if __name__ == '__main__':
    main()
