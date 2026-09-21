#!/bin/bash
# Inside the pinned Linux container, with the prepared source mounted at /work.
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nasm=2.16.03-1 dosbox=0.74-3-5+b1 > /work/packages.log
mkdir -p /tmp/watcom
tar -xf /work/watcom.tar.xz -C /tmp/watcom
export WATCOM=/tmp/watcom
export PATH="$WATCOM/binl64:$WATCOM/binl:$PATH"
export INCLUDE="$WATCOM/h"
cp "$WATCOM/binw/sb.exe" /work/FastDoom-1.3.0/SB.EXE
cp "$WATCOM/binw/ss.exe" /work/FastDoom-1.3.0/SS.EXE
cp "$WATCOM/binw/dos32a.exe" /work/FastDoom-1.3.0/DOS32A.EXE
cd /work/FastDoom-1.3.0/FASTDOOM
make -j4 -f Makefile.gnu fdoom.exe EXTERNOPT=-dMODE_13H > /work/compile.log 2>&1
cp fdoom.exe ../FDOOM13H.EXE
cd ..
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy dosbox -exit -c 'mount c .' -c 'c:' -c 'sb /R FDOOM13H.EXE > bind.log' -c 'ss FDOOM13H.EXE DOS32A.D32 > config.log' -c exit > /work/stub.log 2>&1
grep -qi 'Stub file used' BIND.LOG
grep -qi 'successfully configured' CONFIG.LOG
sha256sum FDOOM13H.EXE
