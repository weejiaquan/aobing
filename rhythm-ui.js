'use strict';
(function () {
  const t = key => window.I18N.t(key);
  function controls(container, settings, save, definitions) {
    if (!container) return;
    const box = document.createElement('div'); box.className = 'rhythm-options';
    for (const d of definitions) {
      const row = document.createElement('label'), label = document.createElement('span');
      label.dataset.i18n = d.label; label.textContent = t(d.label); row.append(label);
      const input = document.createElement('input'); input.type = d.type || 'range';
      input.id = d.key; input.dataset.rhythmSetting = d.key;
      const output = document.createElement('output'); output.htmlFor = d.key;
      const refresh = () => {
        const value = settings[d.key] == null ? d.value : settings[d.key];
        if (input.type === 'checkbox') input.checked = !!value;
        else { input.value = value; output.value = d.format ? d.format(Number(value)) : String(value); }
      };
      if (input.type !== 'checkbox') { input.min=d.min; input.max=d.max; input.step=d.step || 1; }
      refresh();
      input.addEventListener('input', () => { settings[d.key] = input.type === 'checkbox' ? input.checked : Number(input.value); refresh(); });
      input.addEventListener('change', () => { if(save) save(); });
      input.rhythmRefresh = refresh;
      row.append(input); if(input.type !== 'checkbox') row.append(output); box.append(row);
    }
    container.append(box);
  }
  function pausePanel(parent, resume, retry, quit) {
    const dialog=document.createElement('dialog'); dialog.className='rhythm-pause';
    const title=document.createElement('h2'); title.dataset.i18n='rhythm.paused'; title.textContent=t('rhythm.paused');
    const hint=document.createElement('p'); hint.dataset.i18n='rhythm.resume_hint'; hint.textContent=t('rhythm.resume_hint');
    const count=document.createElement('output'); count.setAttribute('aria-live','polite');
    dialog.append(title,hint,count);
    let timer=null, generation=0;
    const buttons=[];
    for(const [key,action] of [['rhythm.resume',()=>{
      if(timer) return;
      const gen=++generation; buttons.forEach(b=>b.disabled=true); count.textContent='1';
      timer=setTimeout(async()=>{
        timer=null; if(gen!==generation) return;
        try { await resume(); if(gen!==generation) return; dialog.close(); count.textContent=''; }
        catch (_) { count.textContent=''; }
        finally { buttons.forEach(b=>b.disabled=false); }
      },1000);
    }],['rhythm.retry',()=>{hide();retry();}],['rhythm.songs',()=>{hide();quit();}]]) {
      const b=document.createElement('button'); b.type='button'; b.dataset.i18n=key; b.textContent=t(key); b.addEventListener('click',action); dialog.append(b); buttons.push(b);
    }
    dialog.addEventListener('cancel',e=>e.preventDefault()); parent.append(dialog);
    function hide() { generation++; clearTimeout(timer); timer=null; if(dialog.open) dialog.close(); count.textContent=''; buttons.forEach(b=>b.disabled=false); }
    return {show(){if(!dialog.open) dialog.showModal();},hide,cancelCountdown(){hide();dialog.showModal();}};
  }
  window.RhythmUI={controls,pausePanel};
})();
