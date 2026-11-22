    (function () {
      function fillImportHints() {
        var ua = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
        var os = /mac|iphone|ipad/i.test(ua) ? 'mac' : /linux|x11|android|cros/i.test(ua) ? 'linux' : 'win';
        var osuPath = { win: '%LocalAppData%\\osu!', mac: '~/Library/Application Support/osu!', linux: '~/.local/share/osu-wine/osu! (or ~/.local/share/osu!)' }[os];
        var steamPath = {
          win: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Hatsune Miku Project DIVA Mega Mix Plus',
          mac: '~/Library/Application Support/Steam/steamapps/common/Hatsune Miku Project DIVA Mega Mix Plus',
          linux: '~/.steam/steam/steamapps/common/Hatsune Miku Project DIVA Mega Mix Plus'
        }[os];
        var skinPath = (os === 'win' ? '%LocalAppData%\\osu!\\Skins\\&lt;SkinName&gt;' : (osuPath + '/Skins/&lt;SkinName&gt;'));
        var osuHint =
          '<span class="ih-line">📁 <b>Beatmaps:</b> your <b>osu! folder</b> or its <b>Songs</b> folder' +
          (os === 'win' ? ' — paste <code>%LocalAppData%\\osu!</code> into the file picker’s address bar' : ' — usually <code>' + osuPath + '</code>') +
          '. A single <b>.osz</b> works too.</span>' +
          '<span class="ih-line">🎨 <b>Skin:</b> a <b>.osk</b> file or an extracted <b>skin folder</b> &mdash; skins live in <code>' + skinPath + '</code>. (Importing the osu! folder also loads its skins.)</span>';
        var phData = { win: '%AppData%\\Project Heartbeat', mac: '~/Library/Application Support/Project Heartbeat', linux: '~/.local/share/Project Heartbeat' }[os];
        var modsHint = 'A mod folder containing <code>rom/</code> &mdash; e.g. <code>…\\Mega Mix Plus\\mods\\&lt;ModName&gt;</code>.';
        var cpkHint = 'Select <b>both</b> <code>diva_main.cpk</code> and <code>diva_main_region.cpk</code> from <code>' + steamPath + '</code> (or your Steam-library drive).';
        var phHint = 'Point at your songs (Steam Workshop <code>…\\steamapps\\workshop\\content\\1216230</code>) <b>and</b> your PH folder <code>' + phData + '</code> for cached audio. Songs you’ve played in PH have audio.';
        var set = function (id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; };
        set('osu-import-hint', osuHint);
        set('vsrg-import-hint', osuHint);
        set('divaft-hint-mods', modsHint);
        set('divaft-hint-cpk', cpkHint);
        set('divaft-hint-ph', phHint);
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fillImportHints);
      else fillImportHints();
    })();
  
