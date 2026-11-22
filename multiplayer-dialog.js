    const multiplayerDialog = document.getElementById('multiplayer-dialog');
    document.getElementById('mp-open-btn').addEventListener('click', function () {
      multiplayerDialog.showModal();
      if (window.MpUI) window.MpUI.open(document.getElementById('mp-panel'));
      else document.getElementById('mp-panel').textContent = I18N.t('mp.offline');
    });
    multiplayerDialog.addEventListener('close', () => { if (window.MpUI) window.MpUI.dismiss(); });
    document.getElementById('mp-close').addEventListener('click', () => multiplayerDialog.close());
    multiplayerDialog.addEventListener('click', (event) => { if (event.target === multiplayerDialog) multiplayerDialog.close(); });
    window.addEventListener('keydown', (event) => { if (multiplayerDialog.open) event.stopPropagation(); }, true);
  
