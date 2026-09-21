"""Apply Aobing's small, checked patch to the pinned FastDoom 1.3.0 source."""
from pathlib import Path
import sys

def patch(root):
    path = root / 'FASTDOOM/r_plane.c'
    source = path.read_text()
    def replace(old, new):
        nonlocal source
        if source.count(old) != 1:
            raise ValueError('Unexpected FastDoom source: ' + old[:70])
        source = source.replace(old, new)
    replace('#define MAXVISPLANES 128', '#define MAXVISPLANES 1024')
    replace('#include <stdlib.h>', '#include <stdlib.h>\n#include <stdio.h>')
    replace('visplane_t *R_FindPlane(fixed_t height, fixed_t prevheight, int picnum, int lightlevel)', '''// Aobing, 2026-09-21: bounds-check both plane allocation paths.
static visplane_t *R_NewPlane(void)
{
    if (lastvisplane >= visplanes + MAXVISPLANES)
    {
        I_Shutdown();
        printf("AOBING_FATAL: visplane capacity exceeded\\n");
        exit(1);
    }
    return lastvisplane++;
}

visplane_t *R_FindPlane(fixed_t height, fixed_t prevheight, int picnum, int lightlevel)''')
    replace('''        lightlevel = 0;
    }

    for (check = visplanes;''', '''        lightlevel = 0;
    }
    else if (highResTimer)
    {
        // Match the same height we store. Sky planes must stay at height zero.
        height = FixedInterpolate(prevheight, height, interpolation_weight);
    }

    for (check = visplanes;''')
    replace('''    lastvisplane++;
    if (highResTimer) {
      check->height = FixedInterpolate(prevheight, height, interpolation_weight);
    } else {
      check->height = height;
    }''', '''    check = R_NewPlane();
    check->height = height;''')
    replace('''    lastvisplane->height = pl->height;
    lastvisplane->picnum = pl->picnum;
    lastvisplane->lightlevel = pl->lightlevel;

    pl = lastvisplane++;''', '''    {
        visplane_t *newplane = R_NewPlane();
        newplane->height = pl->height;
        newplane->picnum = pl->picnum;
        newplane->lightlevel = pl->lightlevel;
        pl = newplane;
    }''')
    path.write_text(source, newline='\n')
    # Upstream's GNU make target assembles this optional unit. NASM requires
    # an explicit size when neither operand is a register.
    asm = root / 'FASTDOOM/fpummx.asm'
    text = asm.read_text()
    if text.count('mov [_hasCPUID],1') != 1:
        raise ValueError('Unexpected CPUID source')
    asm.write_text(text.replace('mov [_hasCPUID],1', 'mov dword [_hasCPUID],1'), newline='\n')

if __name__ == '__main__':
    patch(Path(sys.argv[1]))
