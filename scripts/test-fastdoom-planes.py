"""Compile the actual upstream/patched plane lookup in a small C regression.

Run under Linux/WSL with cc installed. The old function must fail; our patched
function must reuse sky and moving-sector planes and enforce its capacity.
"""
from pathlib import Path
import subprocess
import tarfile
import tempfile
import importlib.util

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('patcher', ROOT / 'scripts/patch-fastdoom.py')
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)

PREFIX = r'''
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
typedef int32_t fixed_t;
typedef struct { int height, picnum, lightlevel, minx, maxx; unsigned char top[324]; int modified; } visplane_t;
#define SCREENWIDTH 320
#define PIXELCOORD_MAX 255
int skyflatnum = 99, highResTimer = 1, interpolation_weight = 32768;
fixed_t FixedInterpolate(fixed_t a, fixed_t b, int weight) { return a + (int64_t)(b-a)*weight/65536; }
void SetDWords(void *p, unsigned v, unsigned count) { unsigned *d=p; while(count--) *d++=v; }
void I_Shutdown(void) {}
'''
MAIN = r'''
int main(int argc, char **argv) {
  int i;
  lastvisplane = visplanes;
  if (argc > 1) {
    for(i=0;i<MAXVISPLANES;i++) R_FindPlane(i, i, i, 128);
    if(argv[1][0]=='s') { visplanes[0].minx=visplanes[0].maxx=0; visplanes[0].top[0]=0; R_CheckPlane(&visplanes[0],0,0); }
    else R_FindPlane(MAXVISPLANES,MAXVISPLANES,MAXVISPLANES,128);
    return 8; // capacity exhaustion must terminate cleanly before writing
  }
  for(i=0;i<100;i++) R_FindPlane(128<<16,128<<16,skyflatnum,128);
  if(lastvisplane-visplanes != 1 || visplanes[0].height != 0) return 2;
  lastvisplane=visplanes;
  for(i=0;i<100;i++) R_FindPlane(128<<16,120<<16,1,128);
  if(lastvisplane-visplanes != 1 || visplanes[0].height != 124<<16) return 3;
  R_FindPlane(128<<16,120<<16,2,128);
  R_FindPlane(128<<16,120<<16,2,160);
  if(lastvisplane-visplanes != 3) return 4;
  highResTimer=0; lastvisplane=visplanes;
  for(i=0;i<100;i++) R_FindPlane(128<<16,120<<16,1,128);
  if(lastvisplane-visplanes != 1 || visplanes[0].height != 128<<16) return 5;
  puts("PASS: sky, interpolated sectors, distinct surfaces, capped rendering");
  return 0;
}
'''

def functions(source):
    start = source.find('static visplane_t *R_NewPlane')
    if start < 0:
        start = source.index('visplane_t *R_FindPlane')
    end = source.index('\n}', source.index('visplane_t *R_CheckPlane')) + 2
    count = source.split('#define MAXVISPLANES ')[1].split()[0]
    declarations = '\n#define MAXVISPLANES ' + count + '\nvisplane_t visplanes[MAXVISPLANES], *lastvisplane;\n'
    return PREFIX + declarations + source[start:end] + MAIN

with tempfile.TemporaryDirectory(prefix='aobing-planes-') as temp:
    target = Path(temp)
    with tarfile.open(ROOT / 'games/dos/sources/fastdoom-1.3.0.tar.gz') as archive:
        for name in ['r_plane.c', 'fpummx.asm']:
            path = target / 'FASTDOOM' / name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(archive.extractfile('FastDoom-1.3.0/FASTDOOM/' + name).read())
    original = (target / 'FASTDOOM/r_plane.c').read_text()
    patcher.patch(target)
    patched = (target / 'FASTDOOM/r_plane.c').read_text()
    for label, source in [('original', original), ('patched', patched)]:
        cfile = target / (label + '.c')
        binary = target / label
        cfile.write_text(functions(source))
        subprocess.run(['cc', '-std=c99', '-Wall', '-Wextra', '-o', str(binary), str(cfile)], check=True)
        result = subprocess.run([str(binary)], capture_output=True, text=True)
        assert result.returncode == (2 if label == 'original' else 0), (label, result)
        print(label + ': ' + (result.stdout.strip() or 'reproduced invalid sky-plane allocation'))
        if label == 'patched':
            for mode in ['allocate', 'split']:
                result = subprocess.run([str(binary), mode], capture_output=True, text=True)
                assert result.returncode == 1 and 'AOBING_FATAL' in result.stdout, result
                print('PASS: bounded ' + mode + ' path')
